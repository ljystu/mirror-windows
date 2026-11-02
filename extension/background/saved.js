// Group tabs keep their first page (optional, off by default: settings page). A tab in a tab
// group remembers the address it had when it joined the group. When you collapse the group,
// or close the group and open it again, the tab is back at that first page, with a fresh
// Back history. Closing a single tab closes it as usual. Like the tabs in an Arc folder. Only the address is kept: what
// you typed or scrolled on the page is not.
//
//   storage.local 'savedTabs' = { nextSid, items: { sid: { url, title, lastUrl } } }
//                               lastUrl: where it is now, to find it again after a restart
//   storage.local 'closedGroups' = [{ title, color, urls, at }]  groups you closed, to reset
//                               their tabs when Chrome opens the group again
//   state.vtabs[vid].sid        a shared (mirrored) group tab
//   state.sbind[tabId] = sid    a group tab in a window that isn't mirrored (or mirroring is off):
//                               the page itself, or its unloaded stand-in (pages/saved.html)
//   state.spos[tabId]           the group a group tab was last in (to tell a closed group from a closed tab)
import { state, flags, run, log } from './state.js';
import { settings, refreshed } from './settings.js';
import {
  tabsCall, createPlaceholder, removeTab,
  vidOf, vidOfReal, urlOf, isPlaceholderTab, ignoreActivation, activate, touch,
} from './tabs.js';
import { forgetShot } from './shots.js';

const NONE = -1;
export const LAZY_URL = chrome.runtime.getURL('pages/saved.html');
export const isLazyTab = (t) => urlOf(t).startsWith(LAZY_URL);
const param = (t, k) => { try { return new URL(urlOf(t)).searchParams.get(k); } catch { return null; } };
const savable = (url) => /^(https?|file|ftp):/.test(url || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function on() {
  await refreshed;
  return !!settings.savedTabs;
}

// ---------- the remembered first pages ----------

let store = null;
async function items() {
  if (!store) store = (await chrome.storage.local.get('savedTabs')).savedTabs || { nextSid: 1, items: {} };
  return store.items;
}
async function persist() { await chrome.storage.local.set({ savedTabs: store }); }
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.savedTabs) store = changes.savedTabs.newValue || { nextSid: 1, items: {} };
});
function newItem(url, title) {
  const sid = String(store.nextSid++);
  store.items[sid] = { url, title: title || '', lastUrl: url };
  return sid;
}

// What a tab is remembered as, if it is: { sid, vid? }.
function bindingOf(tabId) {
  const sid = state.sbind?.[tabId];
  if (sid && store?.items[sid]) return { sid };
  const vid = vidOf(tabId);
  const vsid = vid && state.vtabs[vid]?.sid;
  return vsid && store?.items[vsid] ? { sid: vsid, vid } : null;
}
// Tabs of windows that are mirrored are handled through their vtab.
const mirroredTab = (tabId) => state.enabled && !flags.suppressAll && !!vidOf(tabId);

function lazyUrl(sid) {
  const it = store.items[sid];
  return `${LAZY_URL}?sid=${sid}&u=${encodeURIComponent(it.url)}&t=${encodeURIComponent((it.title || '').slice(0, 200))}`;
}
function resetFields(vt) {
  const it = store.items[vt.sid];
  vt.url = it.url;
  vt.title = it.title || '';
  vt.favIconUrl = '';
}

// ---------- watching the groups ----------

// After tab changes settle: remember the first page of tabs that joined a group, forget tabs
// that left their group, note where each one sits, and reset the tabs of a group Chrome just
// opened again.
let trackTimer = 0;
export function trackSoon() {
  clearTimeout(trackTimer);
  trackTimer = setTimeout(() => run(async () => { if (await on()) await track(); }, 'group tabs'), 150);
}
for (const e of [chrome.tabs.onCreated, chrome.tabs.onMoved, chrome.tabs.onAttached, chrome.tabs.onRemoved]) e.addListener(() => trackSoon());
chrome.tabs.onUpdated.addListener((id, ch) => { if ('groupId' in ch || 'pinned' in ch || 'url' in ch) trackSoon(); });
chrome.tabGroups.onCreated.addListener(() => trackSoon());

async function track() {
  await items();
  state.sbind ||= {};
  state.spos ||= {};
  let changed = false;
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const looks = {};
  for (const g of await chrome.tabGroups.query({})) looks[g.id] = { title: g.title || '', color: g.color, collapsed: g.collapsed };
  if (await reopenedGroups(wins, looks)) changed = true;

  // Shared tabs: by their vtab's group.
  if (state.enabled && !flags.suppressAll) {
    for (const vt of Object.values(state.vtabs)) {
      const inGroup = !!vt.group && !vt.pinned;
      if (inGroup && !store.items[vt.sid] && savable(vt.url)) { vt.sid = newItem(vt.url, vt.title); changed = true; }
      else if (!inGroup && vt.sid) { delete store.items[vt.sid]; delete vt.sid; changed = true; }
    }
  }
  const alive = new Set();
  for (const w of wins) {
    w.tabs.forEach((t, i) => {
      alive.add(String(t.id));
      if (!mirroredTab(t.id) && !isPlaceholderTab(t)) {
        // Window-bound tabs: by their own group.
        const sid = state.sbind[t.id];
        const inGroup = t.groupId !== NONE && !t.pinned;
        if (inGroup && !store.items[sid] && savable(urlOf(t)) && !isLazyTab(t)) { state.sbind[t.id] = newItem(urlOf(t), t.title); changed = true; }
        else if (!inGroup && sid) { delete store.items[sid]; delete state.sbind[t.id]; changed = true; }
      }
      if (!bindingOf(t.id)) { delete state.spos[t.id]; return; }
      state.spos[t.id] = {
        index: i, prev: w.tabs[i - 1]?.id ?? null, next: w.tabs[i + 1]?.id ?? null, groupId: t.groupId,
        group: looks[t.groupId] ? { title: looks[t.groupId].title, color: looks[t.groupId].color } : null,
        size: w.tabs.filter((x) => x.groupId === t.groupId).length,
      };
    });
  }
  // A tab that is gone keeps its entry until its close has been handled.
  for (const id of Object.keys(state.spos)) if (!alive.has(id) && !bindingOf(Number(id))) delete state.spos[id];
  for (const [id, sid] of Object.entries(state.sbind)) if (!alive.has(id) && !state.spos[id]) { delete state.sbind[id]; if (store.items[sid]) { delete store.items[sid]; changed = true; } }
  if (changed) await persist();
}

// ---------- collapsing a group: its tabs go back to their first page, unloaded ----------

chrome.tabGroups.onUpdated.addListener((g) => {
  if (g.collapsed) run(async () => { if (await on()) await resetGroup(g.id); }, 'group collapsed');
});

async function resetGroup(groupId) {
  await items();
  const g = await chrome.tabGroups.get(groupId).catch(() => null);
  if (!g || !g.collapsed) return;
  const done = new Set();
  for (const t of await chrome.tabs.query({ groupId })) {
    const b = bindingOf(t.id);
    if (!b) continue;
    if (b.vid) {
      if (done.has(b.vid)) continue;
      done.add(b.vid);
      await unloadVtab(b.vid, { show: false });
    } else if (!isLazyTab(t)) {
      await unloadPlain(t, b.sid);
    }
  }
  if (!done.size && !(await chrome.tabs.query({ groupId })).some((t) => isLazyTab(t))) return;
  // Chrome can open a collapsed group up again when a tab is put into it: close it again,
  // here and (shared groups) in the other windows.
  const gid = state.gmap?.[groupId];
  const ids = gid ? Object.keys(state.gmap).filter((k) => state.gmap[k] === gid).map(Number) : [groupId];
  if (gid && state.groups[gid]) state.groups[gid].collapsed = true; // so the opening up isn't copied to the other windows
  for (const id of ids) {
    const x = await chrome.tabGroups.get(id).catch(() => null);
    if (x && !x.collapsed) {
      log('group opened up by reset, collapsing again', id);
      touch(id);
      await tabsCall(() => chrome.tabGroups.update(id, { collapsed: true })).catch(() => {});
    }
  }
}

// A shared group tab back at its first page in every window: its live page (wherever it is)
// is swapped for a stand-in, which loads the first page when opened.
async function unloadVtab(vid, { show, skip } = {}) {
  const vt = state.vtabs[vid];
  const R = vt.realTabId != null && vt.realTabId !== skip ? await chrome.tabs.get(vt.realTabId).catch(() => null) : null;
  const was = vt.url;
  resetFields(vt);
  vt.realTabId = null;
  if (R) {
    log('group tab reset', vid, (was || '').slice(0, 60), '->', vt.url.slice(0, 60));
    const ph = await createPlaceholder(R.windowId, vid, R.index);
    if (show && R.active) { ignoreActivation.add(ph.id); await activate(ph.id); }
    await removeTab(R.id);
  }
  if (R || was !== vt.url) await forgetShot(vid);
}

// The same for a tab in a window that isn't mirrored: an unloaded stand-in in its place.
async function unloadPlain(t, sid) {
  const lazy = await tabsCall(() => chrome.tabs.create({ windowId: t.windowId, index: t.index, active: false, url: lazyUrl(sid) }));
  state.sbind[lazy.id] = sid;
  delete state.sbind[t.id];
  if (t.groupId !== NONE) await tabsCall(() => chrome.tabs.group({ groupId: t.groupId, tabIds: [lazy.id] })).catch(() => {});
  await removeTab(t.id);
}

// ---------- closing ----------

// Called for every tab you close (not ours). A tab you close goes as usual (shared ones in
// every window) and is forgotten; a whole group you close is remembered for when Chrome opens
// it again. True only when this handled the close itself.
export async function onSavedRemoved(tabId, info) {
  if (!(await on())) return false;
  await items();
  const b = bindingOf(tabId) || (state.sbind[tabId] ? { sid: state.sbind[tabId] } : null);
  if (!b || !store.items[b.sid] || state.parked[tabId]) return false;
  const p = state.spos[tabId];
  delete state.spos[tabId];
  if (info.isWindowClosing) {
    if (!b.vid) { delete state.sbind[tabId]; delete store.items[b.sid]; await persist(); return false; }
    // The window goes, the other windows keep the tab: opened again, it is at its first page.
    if (!state.enabled || flags.suppressAll || state.ph[tabId]) return false;
    const vt = state.vtabs[b.vid];
    resetFields(vt);
    vt.realTabId = null;
    await forgetShot(b.vid);
    return true;
  }
  if (p && p.size > 1) {
    // The whole group closed? (Chrome closes its tabs one by one, then the group.)
    await sleep(250);
    if (!(await chrome.tabGroups.get(p.groupId).catch(() => null))) await rememberClosedGroup(b, p);
  }
  if (!b.vid) delete state.sbind[tabId];
  delete store.items[b.sid];
  await persist();
  return false;
}

// ---------- closing a whole group and opening it again ----------

const closedBuf = {}; // groupId -> { title, color, urls: [[index, url]] } while its tabs close
async function rememberClosedGroup(b, p) {
  const key = String(p.groupId);
  const rec = closedBuf[key] ||= { title: p.group?.title || '', color: p.group?.color, urls: [] };
  rec.urls.push([p.index, store.items[b.sid].url]);
  clearTimeout(rec.timer);
  rec.timer = setTimeout(async () => {
    delete closedBuf[key];
    const urls = rec.urls.sort((a, c) => a[0] - c[0]).map((x) => x[1]);
    const { closedGroups = [] } = await chrome.storage.local.get('closedGroups');
    closedGroups.push({ title: rec.title, color: rec.color, urls, at: Date.now() });
    await chrome.storage.local.set({ closedGroups: closedGroups.slice(-20) });
    log('group closed', rec.title, urls.length + ' tabs');
  }, 300);
}

// A group that just appeared and looks like one you closed (same name and colour): Chrome
// opened it again from its saved groups. Its tabs go back to their first pages, in order.
async function reopenedGroups(wins, looks) {
  state.gseen ||= [];
  const fresh = Object.keys(looks).filter((id) => !state.gseen.includes(id));
  if (!fresh.length) return false;
  let { closedGroups = [] } = await chrome.storage.local.get('closedGroups');
  let changed = false;
  for (const id of fresh) {
    const look = looks[id];
    const tabs = wins.flatMap((w) => w.tabs).filter((t) => String(t.groupId) === id && !isPlaceholderTab(t));
    const i = closedGroups.findIndex((r) => r.title === look.title && r.color === look.color);
    // Chrome adds the tabs one by one: wait a moment for all of them.
    if (i >= 0 && tabs.length < closedGroups[i].urls.length && !state.gwait?.[id]) { (state.gwait ||= {})[id] = Date.now(); trackSoon(); continue; }
    if (state.gwait?.[id] && i >= 0 && tabs.length < closedGroups[i].urls.length && Date.now() - state.gwait[id] < 3000) { setTimeout(trackSoon, 300); continue; }
    delete state.gwait?.[id];
    state.gseen.push(id);
    if (i < 0) continue;
    const rec = closedGroups.splice(i, 1)[0];
    log('group reopened', look.title, tabs.length + ' tabs');
    for (const [k, t] of tabs.entries()) {
      const url = rec.urls[k];
      if (!url || bindingOf(t.id)) continue;
      if (urlOf(t) !== url) await tabsCall(() => chrome.tabs.update(t.id, { url })).catch(() => {});
      const vid = mirroredTab(t.id) ? vidOfReal(t.id) : null;
      const sid = newItem(url, t.title);
      if (vid) state.vtabs[vid].sid = sid;
      else state.sbind[t.id] = sid;
      changed = true;
    }
  }
  // Forget groups the browser no longer has, and closed groups after a week.
  state.gseen = state.gseen.filter((id) => looks[id]);
  closedGroups = closedGroups.filter((r) => Date.now() - r.at < 7 * 864e5);
  await chrome.storage.local.set({ closedGroups });
  return changed;
}

// ---------- the unloaded stand-in ----------

// It was opened: the page, in a new tab in its place (so the stand-in isn't in the page's
// Back history).
export async function openLazy(tabId) {
  await items();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !isLazyTab(tab)) return;
  const sid = state.sbind[tab.id];
  const url = (sid && store.items[sid]?.url) || param(tab, 'u');
  if (!savable(url)) return;
  const t = await tabsCall(() => chrome.tabs.create({ windowId: tab.windowId, index: tab.index, url, active: tab.active }));
  delete state.sbind[tab.id];
  if (sid && store.items[sid]) state.sbind[t.id] = sid; // a mirrored window takes it over in adopt()
  if (tab.groupId !== NONE) await tabsCall(() => chrome.tabs.group({ groupId: tab.groupId, tabIds: [t.id] })).catch(() => {});
  await removeTab(tab.id);
}

// ---------- keeping track across restarts and mirroring on/off ----------

// The address a group tab is at now, to find it again after the browser restarts.
export async function noteUrl(tabId, tab) {
  if (isPlaceholderTab(tab) || isLazyTab(tab) || !(await on())) return;
  await items();
  const b = bindingOf(tabId);
  const it = b && store.items[b.sid];
  const url = urlOf(tab);
  if (!it || !url || it.lastUrl === url) return;
  it.lastUrl = url;
  await persist();
}

// After a restart (or the setting switched on): entries no tab is bound to find their tab
// again (an unloaded stand-in of theirs, or a group tab at their last or first address).
// Group tabs not remembered yet are picked up by track().
export async function rebind() {
  // Menus of the 1.4.0 test build: gone.
  for (const id of ['saved-save', 'saved-reset', 'saved-forget']) chrome.contextMenus.remove(id, () => void chrome.runtime.lastError);
  if (!(await on())) return;
  await items();
  state.sbind ||= {};
  for (const [t, sid] of Object.entries(state.sbind)) if (!store.items[sid]) delete state.sbind[t];
  for (const vt of Object.values(state.vtabs)) if (vt.sid && !store.items[vt.sid]) delete vt.sid;
  const bound = new Set([...Object.values(state.sbind), ...Object.values(state.vtabs).map((v) => v.sid).filter(Boolean)]);
  const tabs = await chrome.tabs.query({});
  for (const [sid, it] of Object.entries(store.items)) {
    if (bound.has(sid)) continue;
    const lazy = tabs.find((t) => isLazyTab(t) && param(t, 'sid') === sid && !bindingOf(t.id));
    const t = lazy || tabs.find((x) => x.groupId !== NONE && !bindingOf(x.id) && !isPlaceholderTab(x) && !isLazyTab(x) && [it.lastUrl, it.url].includes(urlOf(x)));
    if (!t) { delete store.items[sid]; continue; }
    const vid = !lazy && state.enabled ? vidOfReal(t.id) : null;
    if (vid) state.vtabs[vid].sid = sid;
    else state.sbind[t.id] = sid;
    bound.add(sid);
  }
  await persist();
  trackSoon();
}

// Mirroring switched off: shared group tabs become window-bound ones. One with no live page
// gets an unloaded stand-in in one window (the shared stand-ins are about to go).
export async function toPlain() {
  if (!(await on())) return;
  await items();
  state.sbind ||= {};
  for (const [vid, vt] of Object.entries(state.vtabs)) {
    if (!vt.sid || !store.items[vt.sid]) continue;
    if (vt.realTabId != null) { state.sbind[vt.realTabId] = vt.sid; continue; }
    const ph = Object.keys(state.ph).find((t) => state.ph[t] === vid && !state.parked[t]);
    const p = ph && await chrome.tabs.get(Number(ph)).catch(() => null);
    if (!p) continue;
    const t = await tabsCall(() => chrome.tabs.create({ windowId: p.windowId, index: p.index, active: false, url: lazyUrl(vt.sid) }));
    state.sbind[t.id] = vt.sid;
    if (p.groupId !== NONE) await tabsCall(() => chrome.tabs.group({ groupId: p.groupId, tabIds: [t.id] })).catch(() => {});
  }
}
// Mirroring switched on: window-bound group pages that are now shared carry their entry over.
export function toMirror() {
  for (const vt of Object.values(state.vtabs)) {
    const sid = vt.realTabId != null && state.sbind?.[vt.realTabId];
    if (sid) { vt.sid = sid; delete state.sbind[vt.realTabId]; }
  }
}
// A page that adopt() is about to share: if it is a window-bound group tab, the entry moves to it.
export function takeOver(tabId, vt) {
  const sid = state.sbind?.[tabId];
  if (sid) { vt.sid = sid; delete state.sbind[tabId]; }
}
