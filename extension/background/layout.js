// Building the mirrored layout: on start-up (restore from disk), when switched on
// (rebuild from the open tabs), and when a window opens (fill it in).
import { state, flags, resetState, hooks } from './state.js';
import { applyAllGroups, adoptGroups } from './groups.js';
import { clearShots } from './shots.js';
import {
  syncedWindows, getWin, vidOf, anchorIndex, createPlaceholder, removeTab, snapshotOf,
  isPlaceholderTab, isBlankTab, placeholderVid, isSyncedWindow, pinKey, stripHash, urlOf,
} from './tabs.js';

hooks.saveLayout = saveLayout;
async function saveLayout() {
  if (!state.enabled || flags.suppressAll) return;
  const wins = await syncedWindows();
  const ordered = wins.map((w) => w.tabs.map((t) => vidOf(t.id)).filter(Boolean))
    .sort((a, b) => b.length - a.length)[0] || [];
  const order = [...new Set([...ordered, ...Object.keys(state.vtabs)])].filter((v) => state.vtabs[v]);
  const vtabs = {};
  for (const v of order) {
    const { url, title, pinned, group, sid } = state.vtabs[v];
    vtabs[v] = { url, title, pinned, group: group || null, ...(sid ? { sid } : {}) };
  }
  await chrome.storage.local.set({ layout: { order, vtabs, nextVid: state.nextVid, groups: state.groups, nextGid: state.nextGid } });
}

export async function restore() {
  const saved = (await chrome.storage.local.get('layout')).layout;
  if (!saved || !saved.order.length) return rebuild();
  flags.suppressAll = true;
  try {
    resetState({ nextVid: saved.nextVid, groups: saved.groups || {}, nextGid: saved.nextGid || 1 });
    const wins = await syncedWindows();
    const realFor = {};
    // Chrome's own session restore brings back our stand-ins (they carry their tab's id)
    // and the real pages; reconnect them.
    for (const w of wins) {
      for (const t of w.tabs) {
        const url = urlOf(t);
        if (isPlaceholderTab(t)) {
          const vid = placeholderVid(t);
          if (saved.vtabs[vid]) state.ph[t.id] = vid;
          else await removeTab(t.id);
          continue;
        }
        if (isBlankTab(t)) continue;
        const match = saved.order.find((v) => stripHash(saved.vtabs[v].url) === stripHash(url) &&
          (!realFor[v] || t.pinned)); // a pinned favourite can be open in every window
        if (match && !realFor[match]) realFor[match] = t.id;
        else if (match) { state.ph[t.id] = match; state.parked[t.id] = true; }
        else {
          const vid = String(state.nextVid++);
          state.vtabs[vid] = { realTabId: t.id, ...snapshotOf(t) };
        }
      }
    }
    for (const vid of saved.order) {
      // Tabs Chrome didn't bring back come back as stand-ins that load their page the
      // first time you open them.
      state.vtabs[vid] = { ...saved.vtabs[vid], favIconUrl: '', realTabId: realFor[vid] ?? null };
    }
    // Chrome may bring back pinned tabs of several windows into one: one entry per tab per window.
    for (const w of wins) {
      const seen = new Set();
      const tabs = [...w.tabs].sort((a, b) => (state.ph[a.id] ? 1 : 0) - (state.ph[b.id] ? 1 : 0)); // real pages first
      for (const t of tabs) {
        const vid = state.ph[t.id] || (Object.keys(realFor).find((v) => realFor[v] === t.id));
        if (!vid) continue;
        if (seen.has(vid) && state.ph[t.id]) { delete state.ph[t.id]; delete state.parked[t.id]; await removeTab(t.id); }
        seen.add(vid);
      }
    }
    await fillMissing([...saved.order.filter((v) => state.vtabs[v]), ...Object.keys(state.vtabs).filter((v) => !saved.vtabs[v])]);
    // Chrome brings back each window's groups too: reconnect them, then fill in what's missing.
    for (const w of await syncedWindows()) {
      for (const t of w.tabs) {
        const gid = state.vtabs[vidOf(t.id)]?.group;
        if (gid && t.groupId !== -1 && !state.gmap[t.groupId] &&
          !w.tabs.some((x) => x.groupId !== t.groupId && state.gmap[x.groupId] === gid)) state.gmap[t.groupId] = gid;
      }
    }
    await applyAllGroups();
    state.known = wins.map((w) => w.id);
  } finally {
    flags.suppressAll = false;
  }
}

export async function clearPlaceholders({ keepWindows = false } = {}) {
  const wins = await chrome.windows.getAll({ populate: true });
  for (const w of wins) {
    // A window holding only stand-ins would close with them: leave it a new tab.
    if (keepWindows && w.tabs.length && w.tabs.every(isPlaceholderTab)) await chrome.tabs.create({ windowId: w.id, active: true }).catch(() => {});
    for (const t of w.tabs) if (isPlaceholderTab(t)) await removeTab(t.id);
  }
  state.ph = {};
  state.parked = {};
}

// Share every open tab from scratch (first install, or switched back on).
export async function rebuild() {
  flags.suppressAll = true;
  try {
    await clearPlaceholders();
    state.vtabs = {};
    state.parked = {};
    state.groups = {};
    state.gmap = {};
    const wins = await syncedWindows();
    const byKey = {};
    for (const w of wins) {
      for (const t of w.tabs) {
        if (isPlaceholderTab(t) || isBlankTab(t)) continue;
        const key = t.pinned ? pinKey(urlOf(t)) : null;
        const same = key && byKey[key];
        // Same favourite already seen in another window: park this copy under it.
        if (same && !w.tabs.some((x) => x.id !== t.id && vidOf(x.id) === same)) {
          state.ph[t.id] = same;
          state.parked[t.id] = true;
          continue;
        }
        const vid = String(state.nextVid++);
        state.vtabs[vid] = { realTabId: t.id, ...snapshotOf(t) };
        if (key && !same) byKey[key] = vid;
      }
    }
    await adoptGroups(wins);
    await fillMissing(Object.keys(state.vtabs));
    state.known = wins.map((w) => w.id);
  } finally {
    flags.suppressAll = false;
  }
}

export async function turnOff() {
  flags.suppressAll = true;
  try { await clearPlaceholders({ keepWindows: true }); state.vtabs = {}; await clearShots(); } finally { flags.suppressAll = false; }
}

// A new window gets every shared tab straight away.
export async function ensureWindow(windowId) {
  if (!(await isSyncedWindow(windowId))) return false;
  if (!state.known.includes(windowId)) {
    state.known.push(windowId);
    await fillWindow(windowId);
  }
  return true;
}

// Give a window an entry for every shared tab it doesn't have yet, next to the same
// neighbours as in a window that has them all.
async function fillWindow(windowId) {
  const wins = await syncedWindows();
  const ref = wins.filter((w) => w.id !== windowId)
    .sort((a, b) => b.tabs.filter((t) => vidOf(t.id)).length - a.tabs.filter((t) => vidOf(t.id)).length)[0];
  if (!ref) return;
  let next = 0; // a brand-new window: shared tabs go first, before its own new tab
  const target = await getWin(windowId);
  for (const t of ref.tabs) {
    const vid = vidOf(t.id);
    if (!vid || target.tabs.some((x) => vidOf(x.id) === vid)) continue;
    const index = anchorIndex(target, ref, vid, undefined, next);
    await addStandIn(target, vid, index);
    next = index + 1;
  }
}

// A stand-in in `win` at `index`, and in `win.tabs`, so the next one can be placed without
// reading the window again. Pinning or joining a group can move it: then the window is read.
async function addStandIn(win, vid, index) {
  const t = await createPlaceholder(win.id, vid, index);
  const vt = state.vtabs[vid];
  if (vt.pinned || vt.group) win.tabs = (await getWin(win.id)).tabs;
  else win.tabs.splice(index, 0, t);
}

// Give every window an entry for each of `vids` it lacks, next to the same neighbours as in
// the window where the page is live. One page at a time (so that window already has the
// pages before it), all windows at once, from one read of the tabs.
async function fillMissing(vids) {
  const wins = await syncedWindows();
  for (const vid of vids) {
    const src = wins.find((w) => w.tabs.some((t) => vidOf(t.id) === vid && !state.ph[t.id])) ||
      wins.find((w) => w.tabs.some((t) => vidOf(t.id) === vid));
    await Promise.all(wins.map(async (target) => {
      if (target.tabs.some((t) => vidOf(t.id) === vid)) return;
      await addStandIn(target, vid, src && src !== target ? anchorIndex(target, src, vid) : target.tabs.length);
    }));
  }
}
