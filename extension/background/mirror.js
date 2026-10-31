// The core: bring a vtab's real page into the window you're using, share new tabs,
// close tabs everywhere, and turn stray stand-ins back into something useful.
import { state, run, log, rememberClosed } from './state.js';
import {
  tabsCall, createPlaceholder, removeTab, moveTo, getWin, syncedWindows, anchorIndex,
  vidOf, vidOfReal, snapshotOf, pinKey, isBlankTab, isNewTabPage, isPlaceholderTab, placeholderVid,
  ignoreActivation, selfAttached, touch, PH_URL, activate, swappingOut, isOwnPage,
} from './tabs.js';
import { captureShot, refreshTarget, hasFreshShot, pauseShots, forgetShot } from './shots.js';
import { settings } from './settings.js';
import { gidFor, pruneGroups, applyGroup } from './groups.js';
import { alignWindows } from './order.js';

export async function pull(phTabId, why = '', focusWin) {
  const t0 = performance.now();
  try { await pullNow(phTabId, why, focusWin); } finally { log('pull took', Math.round(performance.now() - t0) + 'ms'); }
}
async function pullNow(phTabId, why, focusWin) {
  log('pull', phTabId, why, 'vid=' + state.ph[phTabId]);
  const vid = state.ph[phTabId];
  if (!vid) return;
  const vt = state.vtabs[vid];
  // A stand-in can be gone by the time a queued request for it runs (an earlier pull removed it).
  const P = await chrome.tabs.get(phTabId).catch(() => null);
  if (!P) { delete state.ph[phTabId]; return; }
  const targetWin = P.windowId;

  let R = null;
  if (vt.realTabId != null) {
    try { R = await chrome.tabs.get(vt.realTabId); } catch { R = null; }
  }
  if (!R) {
    // The real page died (its window was closed): open it again from its URL in a new tab in
    // the stand-in's place. (Loading it into the stand-in itself would leave the stand-in in
    // the tab's Back history, and Back would then turn the page into a stand-in of itself.)
    const url = vt.url && !vt.url.startsWith(PH_URL) ? vt.url : 'chrome://newtab';
    const open = (u) => tabsCall(() => chrome.tabs.create({ windowId: targetWin, index: P.index, url: u, active: true, pinned: !!vt.pinned }));
    const t = await open(url).catch(() => open('chrome://newtab'));
    vt.realTabId = t.id; // before its onCreated runs, so it isn't shared as a brand-new tab
    if (!vt.pinned) await applyGroup(t.id, vt.group);
    delete state.ph[phTabId];
    await removeTab(phTabId);
    return;
  }
  if (R.windowId === targetWin) {
    // An earlier pull got halfway (real tab already here, stand-in left behind): finish it.
    await activate(R.id);
    delete state.ph[phTabId];
    await removeTab(phTabId);
    return;
  }

  const srcWin = R.windowId;
  // A picture from the last couple of seconds is good enough to stand in; only take one
  // now if there is none, so the switch isn't held up by the capture.
  if (R.active && !hasFreshShot(vid)) await captureShot(srcWin, vid, { wait: false });
  pauseShots(1000);
  setTimeout(async () => {
    let job = null;
    await run(async () => { job = await refreshTarget(vid); });
    if (job) await captureShot(...job);
  }, 400);

  if (state.parked[phTabId]) {
    // Swap the live copy with the parked copy: each window keeps its favourite in place.
    swappingOut.add(targetWin);
    try {
      await moveTo(R.id, targetWin, P.index, vt.pinned);
      await moveTo(P.id, srcWin, R.index, vt.pinned);
      await activate(R.id);
    } finally { swappingOut.delete(targetWin); }
    if (R.active) { ignoreActivation.add(P.id); await activate(P.id); }
    await keepFocus(focusWin ?? targetWin);
    return;
  }

  if (!vt.pinned && !vt.group && !R.pinned && !P.pinned && R.groupId === -1 && P.groupId === -1) {
    // Swap the page with its stand-in, both moves sent at once, so each tab strip just trades
    // one tab for its twin in the same spot (no extra tab appearing and another disappearing).
    // If the page was showing where it was, its stand-in (already showing the picture) is
    // shown there in its place.
    // Moves between windows come back as onDetached/onAttached (not onMoved): selfAttached is
    // enough. No touch(): it would make a drag of either tab in the next 1.5 s look like ours.
    selfAttached.add(R.id); selfAttached.add(P.id);
    // Moving the showing stand-in out makes Chrome show a neighbour for a moment: not the user's pick.
    swappingOut.add(targetWin);
    try {
      const [r, p] = await Promise.all([chrome.tabs.get(R.id), chrome.tabs.get(P.id)]); // a drag may have moved them
      // Each lands just before its twin, or in the twin's old spot if the twin already left.
      // Either way that is between two tabs that aren't in one group, so Chrome takes it.
      // (Just after the twin is not: with the twin gone that can be inside the next group.)
      const moves = await Promise.allSettled([
        tabsCall(() => chrome.tabs.move(R.id, { windowId: targetWin, index: p.index })),
        tabsCall(() => chrome.tabs.move(P.id, { windowId: srcWin, index: r.index })),
      ]);
      // Should one still be refused (e.g. groups changed meanwhile), drop it at the end; the
      // order is lined up just below.
      if (moves[0].status === 'rejected') await moveTo(R.id, targetWin, -1, false);
      if (moves[1].status === 'rejected') await moveTo(P.id, srcWin, -1, false);
      if (R.active) ignoreActivation.add(P.id);
      await Promise.all([activate(R.id), R.active && activate(P.id)]);
    } finally { swappingOut.delete(targetWin); }
    await alignWindows(targetWin);
    await keepFocus(focusWin ?? targetWin);
    return;
  }

  // Put a stand-in right after the real page first (showing, if the page was showing), so
  // when the page leaves, its old window goes straight to the stand-in instead of flashing
  // a neighbouring tab. Then move the real page over.
  const stand = await createPlaceholder(srcWin, vid, R.index + 1, R.active);
  try {
    // Where the stand-in is now: a tab drag that was still going on may have moved it.
    const at = (await chrome.tabs.get(P.id).catch(() => P)).index;
    await moveTo(R.id, targetWin, at, vt.pinned);
  } catch (e) {
    // The page couldn't move (e.g. a tab drag in progress): undo, so nothing is doubled.
    delete state.ph[stand.id];
    await removeTab(stand.id);
    if (R.active) await activate(R.id).catch(() => {});
    throw e;
  }
  await activate(R.id);
  delete state.ph[phTabId];
  await removeTab(phTabId);
  // If you were dragging the stand-in, the page took its new spot: copy that to the other windows.
  await alignWindows(targetWin);
  await keepFocus(focusWin ?? targetWin);
}


// Tab operations in the other window can hand it the focus; give it back to the window
// you are using.
async function keepFocus(windowId) {
  const w = await chrome.windows.getLastFocused().catch(() => null);
  if (w && w.id !== windowId) await chrome.windows.update(windowId, { focused: true }).catch(() => {});
}

export async function maybePullActive(windowId) {
  if (!settings.followFocus) return; // only a click brings the page over
  const [t] = await chrome.tabs.query({ active: true, windowId });
  if (t && state.ph[t.id]) await pull(t.id, 'focus');
}

// You switched away from a live page here. If another window is still showing it
// (blurred), give the page back to that window so it's live there again, e.g. a
// video keeps playing in the window you left it in. Focus stays with you.
export async function handBack(tabId, hereWin) {
  const vid = vidOfReal(tabId);
  if (!vid) return;
  const shown = (await chrome.tabs.query({ active: true })).find((t) => t.windowId !== hereWin && state.ph[t.id] === vid);
  if (shown) await pull(shown.id, 'hand back', hereWin);
}

export async function closeVtab(vid) {
  const vt = state.vtabs[vid];
  if (!vt) return;
  rememberClosed(vid, vt.url);
  await unshare(vid);
  if (vt.realTabId != null) await removeTab(vt.realTabId);
}

// Stop sharing a page: its stand-ins go, the page itself stays where it is.
export async function unshare(vid) {
  if (!state.vtabs[vid]) return;
  delete state.vtabs[vid];
  for (const [tabId, v] of Object.entries(state.ph)) {
    if (v !== vid) continue;
    delete state.ph[tabId];
    // A parked favourite copy is the window's own tab: leave it as a normal tab.
    if (state.parked[tabId]) { delete state.parked[tabId]; continue; }
    await removeTab(Number(tabId));
  }
  await forgetShot(vid);
  pruneGroups();
}

// The new tab a new window opens with isn't shared (the window already gets every shared
// tab). Noted as the events happen, outside the queue, which can be seconds behind.
const windowBornAt = {}; // windowId -> when it opened
const firstTabs = new Set(); // ids of those first tabs
export function noteWindowBorn(windowId) { windowBornAt[windowId] = Date.now(); }
export function noteTabBorn(tab) {
  if (Date.now() - (windowBornAt[tab.windowId] || 0) < 1500 && tab.index === 0) firstTabs.add(tab.id);
}

// Share a tab with the other windows. Cmd+T new tabs are shared right away; the new tab a
// new window opens with is not (the window already gets every shared tab), nor are
// about:blank pop-ups until they go somewhere.
export async function adopt(tab) {
  if (state.ph[tab.id] || vidOfReal(tab.id)) return;
  const fresh = await chrome.tabs.get(tab.id).catch(() => null);
  if (!fresh || isPlaceholderTab(fresh) || isOwnPage(fresh)) return;
  if (isBlankTab(fresh) && !(isNewTabPage(fresh) && !firstTabs.has(fresh.id))) return;
  const key = fresh.pinned ? pinKey(fresh.pendingUrl || fresh.url) : null;
  const same = key && Object.keys(state.vtabs).find((v) => state.vtabs[v].pinned && pinKey(state.vtabs[v].url) === key);
  if (same) {
    // This window opened its own copy of a favourite that is already live elsewhere:
    // park it in place of our placeholder, then bring the live one here if it's in use.
    const here = await getWin(tab.windowId);
    for (const t of here.tabs) {
      if (t.id !== tab.id && state.ph[t.id] === same && !state.parked[t.id]) { delete state.ph[t.id]; await removeTab(t.id); }
    }
    state.ph[tab.id] = same;
    state.parked[tab.id] = true;
    if (fresh.active) await pull(tab.id);
    return;
  }

  const vid = String(state.nextVid++);
  // A link opened from a grouped tab lands in that group.
  state.vtabs[vid] = { realTabId: tab.id, ...snapshotOf(fresh), group: fresh.pinned ? null : await gidFor(fresh.groupId) };
  const src = await getWin(fresh.windowId);
  for (const w of await syncedWindows()) {
    if (w.id !== fresh.windowId) await createPlaceholder(w.id, vid, anchorIndex(w, src, vid));
  }
}

// A stand-in we aren't tracking: Chrome brought it back (Cmd+Shift+T, "reopen closed
// window") after we had closed it. Make it useful again.
export async function claimStray(tab) {
  if (state.ph[tab.id] || !isPlaceholderTab(tab)) return;
  tab = await chrome.tabs.get(tab.id).catch(() => null); // the event's copy can be out of date
  if (!tab || state.ph[tab.id]) return;
  const vid = placeholderVid(tab);
  if (state.vtabs[vid]) {
    // Its page is still shared: keep it if this window has no entry for that page yet,
    // otherwise it's a duplicate.
    const here = await getWin(tab.windowId).catch(() => null);
    if (here && !here.tabs.some((t) => t.id !== tab.id && vidOf(t.id) === vid)) { state.ph[tab.id] = vid; return; }
    await removeTab(tab.id);
    return;
  }
  // Its page was closed: open the page itself here; it is then shared again like any new tab.
  const url = state.closed[vid] || new URL(tab.pendingUrl || tab.url).searchParams.get('u') || '';
  delete state.closed[vid];
  log('stray stand-in', tab.id, 'vid=' + vid, '->', url.slice(0, 80));
  // A new tab in its place rather than loading the page into the stand-in, which would stay in
  // the tab's Back history.
  if (url) {
    const target = /^(https?|file|ftp):/.test(url) ? url : 'chrome://newtab'; // e.g. a closed Cmd+T tab
    await tabsCall(() => chrome.tabs.create({ windowId: tab.windowId, index: tab.index, url: target, active: tab.active, pinned: tab.pinned }));
  }
  await removeTab(tab.id);
}
