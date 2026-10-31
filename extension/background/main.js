// Mirror Windows: every normal window shows the same tabs. Each page lives in exactly one
// window; the others show a stand-in. Activating a stand-in moves the real tab there with
// chrome.tabs.move, which keeps the page alive: inputs, scroll, JS state, media all survive.
//
// Pinned tabs that each window opened on its own (e.g. Gmail) are merged into one shared
// page by site; the extra copies are "parked" and swap places with the live one.
//
// This file only wires Chrome events to the modules below:
//   state.js   state, event queue, persistence      tabs.js    tab/window helpers
//   layout.js  restore / rebuild / new windows       mirror.js  switching, sharing, closing
//   shots.js   pictures for the stand-ins            groups.js  tab groups
//   debug.js   the debug page's data
import { state, flags, run, log, coldStart } from './state.js';
import { restore, rebuild, turnOff, ensureWindow } from './layout.js';
import { pull, maybePullActive, handBack, closeVtab, unshare, adopt, claimStray, noteWindowBorn, noteTabBorn } from './mirror.js';
import { settings, mayPicture, refreshed } from './settings.js';
import {
  selfRemoved, selfMoved, selfAttached, ignoreActivation, selfActivated, swappingOut, isPlaceholderTab, isSyncedWindow,
  syncedWindows, getWin, vidOf, vidOfReal, snapshotOf, anchorIndex, tabsCall, removeTab,
  createPlaceholder, markReady, touch, ours,
} from './tabs.js';
import { startShotLoop, clearShots, forgetShot } from './shots.js';
import { onTabGroupChanged, onGroupUpdated, onGroupRemoved, pruneGroups } from './groups.js';
import { alignWindows } from './order.js';
import { debugDump } from './debug.js';

// ---------- start-up ----------

// Whenever this worker starts without state from earlier in this browser session (browser
// start, install, update, switched back on in chrome://extensions), rebuild the windows
// from the saved layout. A worker merely waking up from idle keeps its state.
async function startUp() {
  if (!coldStart) return;
  const { enabled } = await chrome.storage.local.get('enabled');
  state.enabled = enabled !== false;
  if (state.enabled) await restore();
  await updateBadge();
}
run(startUp, 'startup');

const updateBadge = () => chrome.action.setBadgeText({ text: state.enabled ? '' : chrome.i18n.getMessage('badgeOff') });

// First install: a short welcome page (what the blurred tabs are, page previews, settings).
// The toolbar button's right-click menu gets "New window that isn't mirrored".
chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.contextMenus.create({ id: 'blank-window', title: chrome.i18n.getMessage('menuBlankWindow'), contexts: ['action'] }, () => void chrome.runtime.lastError);
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('pages/welcome.html') });
});
// A window of its own, like Arc's blank window: its tabs aren't shared, and the shared
// tabs don't show up in it.
function openBlankWindow() {
  return run(async () => {
    const w = await chrome.windows.create({ focused: true });
    state.excluded.push(w.id); // before its onCreated runs (queued after this)
  }, 'blank window');
}
chrome.contextMenus.onClicked.addListener((info) => { if (info.menuItemId === 'blank-window') openBlankWindow(); });
self.__mwBlankWindow = openBlankWindow; // for the tests
// Previews switched off: the pictures already taken go too.
chrome.permissions.onRemoved.addListener(() => run(() => clearShots(), 'previews off'));
// A site added to "never preview": its pictures go now, not when the browser closes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  run(async () => {
    await refreshed;
    for (const [vid, vt] of Object.entries(state.vtabs)) if (!mayPicture(vt.url)) await forgetShot(vid);
  }, 'settings');
});

// Clicking the toolbar button switches mirroring on and off.
chrome.action.onClicked.addListener(() => run(async () => {
  state.enabled = !state.enabled;
  await chrome.storage.local.set({ enabled: state.enabled });
  if (state.enabled) await rebuild();
  else await turnOff();
  await updateBadge();
}, 'toggle'));

// ---------- windows ----------

chrome.windows.onCreated.addListener((w) => noteWindowBorn(w.id)); // outside the queue: must be set before the tab arrives
chrome.windows.onCreated.addListener((w) => run(async () => {
  if (state.enabled && !flags.suppressAll) await ensureWindow(w.id);
}, 'window created'));

chrome.windows.onFocusChanged.addListener((windowId) => run(async () => {
  if (!state.enabled || flags.suppressAll || windowId === chrome.windows.WINDOW_ID_NONE) return;
  await maybePullActive(windowId);
}, 'focus'));

chrome.windows.onRemoved.addListener((windowId) => run(async () => {
  state.known = state.known.filter((id) => id !== windowId);
  state.excluded = state.excluded.filter((id) => id !== windowId);
}, 'window removed'));

// ---------- tabs ----------

chrome.tabs.onCreated.addListener(noteTabBorn); // outside the queue, like noteWindowBorn
chrome.tabs.onCreated.addListener((tab) => run(async () => {
  if (!state.enabled || flags.suppressAll) return;
  if (isPlaceholderTab(tab)) { await claimStray(tab); return; }
  if (!(await ensureWindow(tab.windowId))) return;
  await adopt(tab);
}, 'tab created'));

chrome.tabs.onRemoved.addListener((tabId, info) => run(async () => {
  if (selfRemoved.delete(tabId)) return;
  if (!state.enabled || flags.suppressAll) return;
  if (state.ph[tabId]) {
    const vid = state.ph[tabId];
    delete state.ph[tabId];
    if (state.parked[tabId]) { delete state.parked[tabId]; return; }
    if (!info.isWindowClosing) await closeVtab(vid); // closing a stand-in closes the tab everywhere
    return;
  }
  const vid = vidOfReal(tabId);
  if (!vid) return;
  const heir = Object.keys(state.parked).find((t) => state.ph[t] === vid);
  if (heir) {
    // A live favourite went away but other windows still have their copy: one becomes live.
    delete state.parked[heir]; delete state.ph[heir];
    state.vtabs[vid].realTabId = Number(heir);
    return;
  }
  if (info.isWindowClosing) state.vtabs[vid].realTabId = null; // revived from its URL on the next pull
  else await closeVtab(vid);
}, 'tab removed'));

// Chrome swaps a tab for a new one with a new id when it frees its memory (Memory Saver,
// "discarded" tabs) or prerenders a page: follow it, or the page would look like a
// brand-new tab and show up twice.
chrome.tabs.onReplaced.addListener((added, removed) => run(async () => {
  const vid = vidOfReal(removed);
  if (vid) state.vtabs[vid].realTabId = added;
  if (state.ph[removed]) {
    state.ph[added] = state.ph[removed];
    delete state.ph[removed];
    if (state.parked[removed]) { state.parked[added] = true; delete state.parked[removed]; }
  }
  log('replaced', removed, '->', added, vid ? 'vid=' + vid : '');
}, 'replaced'));

const lastActive = {}; // windowId -> the tab that was showing there

// Every activation as it happens, outside the queue: the last one the user made in each window.
// Tabs flicked past (Ctrl+Tab, Cmd+1..9) are then left alone by the queued handler below.
const userShown = {}; // windowId -> tab id
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (selfActivated.delete(tabId)) return;
  // Chrome shows a neighbour for a moment while a switch moves a stand-in out: not the user's pick.
  if (swappingOut.has(windowId) && state.ph?.[tabId]) { ignoreActivation.add(tabId); return; }
  userShown[windowId] = tabId;
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => run(async () => {
  log('activated', tabId, 'win=' + windowId, state.ph[tabId] ? 'placeholder' : '');
  const prev = lastActive[windowId];
  lastActive[windowId] = tabId;
  if (ignoreActivation.delete(tabId)) return;
  if (!state.enabled || flags.suppressAll) return;
  // Only follow activations the user made in the window they are using.
  if (!(await chrome.windows.get(windowId).catch(() => ({}))).focused) return; // focus may arrive just after: onFocusChanged covers it
  if (state.ph[tabId]) {
    // By now an earlier pull may have swapped this stand-in into another window: only pull
    // it if it is still in this window. And only if the user didn't go on to another tab there.
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (t && t.windowId === windowId && userShown[windowId] === tabId) await pull(tabId, 'activated');
    else if (t) log('skipped', tabId, 'user went on to', userShown[windowId]);
  }
  if (prev != null && prev !== tabId) await handBack(prev, windowId);
}, 'activated'));

chrome.tabs.onUpdated.addListener((tabId, change, tab) => run(async () => {
  if (!state.enabled || flags.suppressAll) return;
  if ('groupId' in change) await onTabGroupChanged(tabId);
  const vid = vidOfReal(tabId);
  if (!vid) {
    // An empty tab just went somewhere: share it now.
    if (change.url && !state.ph[tabId] && (await isSyncedWindow(tab.windowId))) await adopt(tab);
    return;
  }
  const vt = state.vtabs[vid];
  const pinnedChanged = 'pinned' in change && change.pinned !== vt.pinned;
  Object.assign(vt, snapshotOf(tab));
  if (pinnedChanged) {
    // Pinning takes a tab out of its group (Chrome does it): it doesn't go back when unpinned.
    if (vt.pinned && vt.group) { vt.group = null; pruneGroups(); }
    for (const [ph, v] of Object.entries(state.ph)) {
      if (v === vid) await tabsCall(() => chrome.tabs.update(Number(ph), { pinned: !!vt.pinned })).catch(() => {});
    }
  }
}, 'updated'));

// User reordered a tab (or dragged a whole group): mirror the move in the other windows.
// Moves we made ourselves to keep the other windows in line don't count.
chrome.tabs.onMoved.addListener((tabId, { windowId }) => run(async () => {
  if (selfMoved.delete(tabId) || ours(tabId) || !state.enabled || flags.suppressAll) return;
  const vid = vidOf(tabId);
  if (!vid) return;
  alignSoon(windowId);
}, 'moved'));

// User dragged a real tab into another synced window: swap stand-ins accordingly.
const detachedFrom = {};
chrome.tabs.onDetached.addListener((tabId, { oldWindowId, oldPosition }) => {
  detachedFrom[tabId] = { oldWindowId, oldPosition };
});
chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => run(async () => {
  const from = detachedFrom[tabId];
  delete detachedFrom[tabId];
  if (selfAttached.delete(tabId) || !state.enabled || flags.suppressAll || !from) return;
  const vid = vidOfReal(tabId);
  const synced = await isSyncedWindow(newWindowId);
  if (!vid) {
    // From a window that isn't mirrored into one that is: share it from now on.
    if (synced && !state.ph[tabId]) await adopt({ id: tabId, windowId: newWindowId });
    return;
  }
  if (!synced) { await unshare(vid); return; } // taken out into a window that isn't mirrored
  const wins = await syncedWindows();
  const target = wins.find((w) => w.id === newWindowId);
  const dupe = target?.tabs.find((t) => t.id !== tabId && state.ph[t.id] === vid);
  if (dupe) { delete state.ph[dupe.id]; await removeTab(dupe.id); }
  if (wins.some((w) => w.id === from.oldWindowId)) await createPlaceholder(from.oldWindowId, vid, from.oldPosition);
  alignSoon(newWindowId); // where you dropped it is where it goes in every window
}, 'attached'));

// ---------- tab groups: name, colour, collapsed ----------

chrome.tabGroups.onUpdated.addListener((g) => run(async () => {
  if (state.enabled && !flags.suppressAll) await onGroupUpdated(g.id);
}, 'group updated'));
chrome.tabGroups.onRemoved.addListener((g) => run(async () => onGroupRemoved(g), 'group removed'));
chrome.tabGroups.onMoved.addListener((g) => { if (!ours(g.id)) alignSoon(g.windowId); });

// A drag fires a stream of moves (and Chrome refuses tab edits until the mouse is
// released): line the other windows up once the moves stop.
let alignTimer = 0;
function alignSoon(windowId) {
  clearTimeout(alignTimer);
  alignTimer = setTimeout(() => run(() => alignWindows(windowId), 'align order'), 300);
}

// ---------- messages from the stand-ins and the debug page ----------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'ready' && sender.tab) {
    markReady(sender.tab.id); // right away, not queued: a pull may be waiting on it
    return;
  }
  if (msg?.type === 'dump') {
    run(async () => reply(await debugDump()), 'dump');
    return true;
  }
  if (msg?.type !== 'pull' || !sender.tab) return;
  // A stand-in asks for its page: it got focus, or the user clicked it.
  run(async () => {
    if (!state.ph[sender.tab.id]) {
      const t = await chrome.tabs.get(sender.tab.id).catch(() => null);
      if (t && state.enabled) await claimStray(t);
      return;
    }
    if (!msg.explicit) {
      if (!settings.followFocus) return; // only a click brings the page over
      // The page thinks it is in use; double-check: it must be the active tab of the focused window.
      const t = await chrome.tabs.get(sender.tab.id).catch(() => null);
      if (!t || !t.active || !(await chrome.windows.get(t.windowId)).focused) return;
    }
    await pull(sender.tab.id, msg.explicit ? 'click' : 'visible');
  }, 'pull message');
});

// Alt+Shift+D opens the debug page (window/tab layout and recent events, downloadable).
chrome.commands.onCommand.addListener((command) => {
  if (command === 'debug') chrome.tabs.create({ url: chrome.runtime.getURL('pages/debug.html') });
});

startShotLoop();
