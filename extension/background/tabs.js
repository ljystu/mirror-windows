// Tab and window helpers: identifying tabs, finding where a tab belongs, making stand-ins.
import { state, log } from './state.js';
import { applyGroup } from './groups.js';

export const PH_URL = chrome.runtime.getURL('pages/placeholder.html');

export const selfRemoved = new Set(); // tab ids we are closing ourselves
export const selfActivated = new Set(); // tab ids we are showing ourselves (not the user)
export const swappingOut = new Set(); // windows a showing stand-in is being moved out of

// Show a tab, marked as our doing so it isn't taken for the user's choice.
export async function activate(tabId) {
  selfActivated.add(tabId);
  setTimeout(() => selfActivated.delete(tabId), 1000); // no event comes if it was showing already
  return tabsCall(() => chrome.tabs.update(tabId, { active: true }));
}
// tab id -> how many onMoved events our own moves will cause (one move can cause several)
export const selfMoved = {
  m: new Map(),
  add(id) { this.m.set(id, (this.m.get(id) || 0) + 1); },
  delete(id) { const n = this.m.get(id); if (!n) return false; if (n > 1) this.m.set(id, n - 1); else this.m.delete(id); return true; },
};
export const selfAttached = new Set(); // tab ids we are moving ourselves to another window (onAttached)
export const ignoreActivation = new Set(); // tabs we activated ourselves in a background window

// Tabs and groups we just moved, grouped or updated ourselves. Chrome reports those changes
// back to us a moment later; they must not be copied to the other windows as if you made
// them. (Window focus can't tell: Chrome's group editor and tab drags take focus away.)
const touched = new Map(); // tab or group id -> until when
export function touch(...ids) { for (const id of ids) touched.set(id, Date.now() + 1500); }
export const ours = (id) => (touched.get(id) || 0) > Date.now();

// Chrome refuses tab edits while the mouse is down on the tab strip ("user may be
// dragging a tab"), which is exactly when a click activates a tab. Retry briefly.
export async function tabsCall(fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= 100 || !/cannot be edited|dragging/i.test(String(e && e.message))) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

export const urlOf = (t) => t.pendingUrl || t.url || '';
export const stripHash = (url) => (url || '').split('#')[0];
export const isPlaceholderTab = (t) => urlOf(t).startsWith(PH_URL);
// The extension's own pages (welcome, settings, debug) stay in the window they open in.
export const isOwnPage = (t) => urlOf(t).startsWith(chrome.runtime.getURL(''));
export const placeholderVid = (t) => new URL(urlOf(t)).searchParams.get('vid');
// A fresh empty tab (Cmd+T).
export const isNewTabPage = (t) => /^(chrome:\/\/(newtab|new-tab-page)|chrome-search:)/.test(urlOf(t));
// Not shared: empty tabs, and this extension's own pages (the debug page).
const OWN_URL = chrome.runtime.getURL('');
export const isBlankTab = (t) => /^(chrome:\/\/(newtab|new-tab-page)|chrome-search:|about:blank|$)/.test(urlOf(t)) ||
  (urlOf(t).startsWith(OWN_URL) && !isPlaceholderTab(t));
export const vidOfReal = (tabId) => Object.keys(state.vtabs).find((v) => state.vtabs[v].realTabId === tabId);
export const vidOf = (tabId) => state.ph[tabId] || vidOfReal(tabId);

export function snapshotOf(t) {
  return { url: urlOf(t), title: t.title || '', favIconUrl: t.favIconUrl || '', pinned: t.pinned };
}

// Pinned tabs are the same favourite when they are on the same site section,
// e.g. mail.google.com/mail or calendar.google.com/calendar.
export function pinKey(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.hostname + '/' + (u.pathname.split('/')[1] || '');
  } catch { return null; }
}

// Where vid belongs in `target` so it sits next to the same neighbours it has in `src`.
// Both are populated windows. excludeId: a tab in target to leave out (the one being moved).
export function anchorIndex(target, src, vid, excludeId, fallback) {
  const tabs = target.tabs.filter((t) => t.id !== excludeId);
  const k = src.tabs.findIndex((t) => vidOf(t.id) === vid);
  for (let j = k - 1; j >= 0; j--) {
    const v = vidOf(src.tabs[j].id);
    const i = v ? tabs.findIndex((t) => vidOf(t.id) === v) : -1;
    if (i >= 0) return i + 1;
  }
  for (let j = k + 1; j < src.tabs.length; j++) {
    const v = vidOf(src.tabs[j].id);
    const i = v ? tabs.findIndex((t) => vidOf(t.id) === v) : -1;
    if (i >= 0) return i;
  }
  return fallback ?? tabs.length;
}

export const getWin = (id) => chrome.windows.get(id, { populate: true });

export async function syncedWindows() {
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'], populate: true });
  return wins.filter((w) => !w.incognito && !state.excluded.includes(w.id));
}
export async function isSyncedWindow(windowId) {
  if (state.excluded.includes(windowId)) return false;
  try {
    const w = await chrome.windows.get(windowId);
    return w.type === 'normal' && !w.incognito;
  } catch { return false; }
}

export async function createPlaceholder(windowId, vid, index, active = false) {
  const vt = state.vtabs[vid];
  // Always created in the background: an active create can pull window focus along.
  const t = await tabsCall(() => chrome.tabs.create({
    windowId, index, active: false, pinned: !!vt.pinned,
    // The page's address rides along so a stand-in brought back by Cmd+Shift+T can find its way.
    // The title rides along too, so the tab shows it from its first frame.
    url: `${PH_URL}?vid=${vid}&u=${encodeURIComponent(vt.url || '')}&t=${encodeURIComponent((vt.title || '').slice(0, 200))}`,
  }));
  state.ph[t.id] = vid;
  // In its group, or out of one Chrome put it in for landing inside a group.
  await applyGroup(t.id, vt.group);
  if (active) {
    const w0 = performance.now();
    await whenReady(t.id, 250); // its first frame then already has the picture
    log('stand-in ready after', Math.round(performance.now() - w0) + 'ms');
    ignoreActivation.add(t.id);
    await activate(t.id);
  }
  return t;
}

// Stand-ins report once their picture is up ('ready' message).
const readyTabs = new Set();
const readyWaiters = {};
function whenReady(tabId, ms) {
  if (readyTabs.delete(tabId)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { delete readyWaiters[tabId]; resolve(); };
    readyWaiters[tabId] = done;
    setTimeout(done, ms);
  });
}
export function markReady(tabId) {
  const waiter = readyWaiters[tabId];
  if (waiter) waiter();
  else { readyTabs.add(tabId); setTimeout(() => readyTabs.delete(tabId), 5000); }
}

export async function removeTab(tabId) {
  selfRemoved.add(tabId);
  try { await tabsCall(() => chrome.tabs.remove(tabId)); } catch { selfRemoved.delete(tabId); }
}

// Move a tab to an exact spot; moving between windows can drop the pin, which would
// otherwise send the tab to the end of the pinned group.
export async function moveTo(tabId, windowId, index, pinned) {
  // Moving a pinned tab across windows can crash Chromium, so unpin it for the trip.
  const t0 = await chrome.tabs.get(tabId);
  if (t0.pinned) {
    const u = await tabsCall(() => chrome.tabs.update(tabId, { pinned: false }));
    if (u.index !== t0.index) selfMoved.add(tabId); // unpinning slid it past other pinned tabs
  }
  if (t0.windowId !== windowId) selfAttached.add(tabId);
  touch(tabId);
  let m;
  try {
    [m] = [].concat(await tabsCall(() => chrome.tabs.move(tabId, { windowId, index })));
  } catch (e) {
    // A tab outside a group can't land between two tabs of a group: drop it at the end,
    // it joins its group and goes to its spot below.
    if (!/group continuity/i.test(String(e && e.message))) throw e;
    [m] = [].concat(await tabsCall(() => chrome.tabs.move(tabId, { windowId, index: -1 })));
  }
  if (!m || !!m.pinned !== !!pinned) {
    const t = await tabsCall(() => chrome.tabs.update(tabId, { pinned: !!pinned }));
    if (m && t.index !== m.index) selfMoved.add(tabId); // pinning slid it to the pinned group
  }
  // Moving to another window takes a tab out of its group: put it in the group there.
  const vid = vidOf(tabId);
  if (vid && !pinned) await applyGroup(tabId, state.vtabs[vid].group);
  if ((await chrome.tabs.get(tabId)).index !== index) {
    selfMoved.add(tabId);
    await tabsCall(() => chrome.tabs.move(tabId, { index })).catch(() => selfMoved.delete(tabId));
    if (vid && !pinned) await applyGroup(tabId, state.vtabs[vid].group); // in case that took it out
  }
}
