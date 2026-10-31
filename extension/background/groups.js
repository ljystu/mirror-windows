// Tab groups: the same groups (name, colour, collapsed, members) in every window.
//
//   state.groups[gid] = { title, color, collapsed }   one shared group
//   state.gmap[groupId] = gid                          each window's Chrome group for it
//   state.vtabs[vid].group = gid | null
//
// A change you make is copied to the other windows. A change that comes from our own
// moves (Chrome taking a tab we moved out of its group, a stand-in created inside a group)
// is put back to match the shared groups.
import { state, log } from './state.js';
import { tabsCall, vidOf, syncedWindows, touch, ours } from './tabs.js';
import { alignWindows } from './order.js';

const NONE = chrome.tabGroups.TAB_GROUP_ID_NONE;
const propsOf = (g) => ({ title: g.title || '', color: g.color, collapsed: !!g.collapsed });
const sameProps = (a, b) => a && b && a.title === b.title && a.color === b.color && a.collapsed === b.collapsed;

// The shared group for a window's Chrome group, made on first sight.
export async function gidFor(groupId) {
  if (groupId === NONE || groupId == null) return null;
  if (state.gmap[groupId]) return state.gmap[groupId];
  const g = await chrome.tabGroups.get(groupId).catch(() => null);
  if (!g) return null;
  const gid = 'g' + state.nextGid++;
  state.groups[gid] = propsOf(g);
  state.gmap[groupId] = gid;
  return gid;
}

// This window's Chrome group for gid, if it has one.
export async function groupHere(windowId, gid) {
  const gs = await chrome.tabGroups.query({ windowId });
  const g = gs.find((x) => state.gmap[x.id] === gid);
  if (g) return g;
  // Lost track of it (e.g. an update failed mid-drag): a group here holding gid's tabs is it.
  const tabs = await chrome.tabs.query({ windowId });
  const t = tabs.find((x) => x.groupId !== NONE && !state.gmap[x.groupId] && state.vtabs[vidOf(x.id)]?.group === gid);
  if (!t) return null;
  state.gmap[t.groupId] = gid;
  return gs.find((x) => x.id === t.groupId) || null;
}

// Put one tab in the shared group gid (null: in no group) within its own window.
export async function applyGroup(tabId, gid) {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (!t || t.pinned) return; // pinned tabs can't be in a group
  if (!gid || !state.groups[gid]) {
    if (t.groupId !== NONE) { touch(tabId); await tabsCall(() => chrome.tabs.ungroup(tabId)).catch(() => {}); }
    return;
  }
  if (state.gmap[t.groupId] === gid) return;
  touch(tabId);
  const g = await groupHere(t.windowId, gid);
  if (g) {
    await tabsCall(() => chrome.tabs.group({ groupId: g.id, tabIds: [tabId] }));
    return;
  }
  const groupId = await tabsCall(() => chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: t.windowId } }));
  state.gmap[groupId] = gid;
  touch(groupId);
  await tabsCall(() => chrome.tabGroups.update(groupId, state.groups[gid])).catch(() => {});
}

// A tab's group changed (tabs.onUpdated groupId).
export async function onTabGroupChanged(tabId) {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  const vid = t && vidOf(t.id);
  if (!vid || t.pinned) return;
  const vt = state.vtabs[vid];
  const cur = await gidFor(t.groupId);
  if (cur === (vt.group || null)) return;
  if (ours(t.id)) { await applyGroup(t.id, vt.group); return; } // our own doing: put it back
  log('group', vid, (vt.group || '-') + ' -> ' + (cur || '-'));
  vt.group = cur;
  for (const w of await syncedWindows()) {
    if (w.id === t.windowId) continue;
    const twin = w.tabs.find((x) => vidOf(x.id) === vid);
    if (twin) await applyGroup(twin.id, cur);
  }
  await alignWindows(t.windowId);
  pruneGroups();
}

// Name, colour or collapsed changed: the same everywhere. If it's one of our own updates
// still landing, make sure it ends up matching the shared group.
export async function onGroupUpdated(groupId) {
  const gid = state.gmap[groupId];
  const g = gid && await chrome.tabGroups.get(groupId).catch(() => null); // the event's copy can be stale
  if (!g || sameProps(state.groups[gid], propsOf(g))) return;
  if (ours(g.id)) {
    await tabsCall(() => chrome.tabGroups.update(g.id, state.groups[gid])).catch(() => {});
    return;
  }
  state.groups[gid] = propsOf(g);
  for (const [groupId, id] of Object.entries(state.gmap)) {
    if (id !== gid || Number(groupId) === g.id) continue;
    touch(Number(groupId));
    await tabsCall(() => chrome.tabGroups.update(Number(groupId), state.groups[gid]))
      .catch((e) => { if (/no group/i.test(String(e && e.message))) delete state.gmap[groupId]; });
  }
}

export function onGroupRemoved(g) {
  delete state.gmap[g.id];
}

// Forget shared groups no tab is in any more.
export function pruneGroups() {
  const used = new Set(Object.values(state.vtabs).map((v) => v.group).filter(Boolean));
  for (const gid of Object.keys(state.groups)) if (!used.has(gid)) delete state.groups[gid];
  for (const [groupId, gid] of Object.entries(state.gmap)) if (!state.groups[gid]) delete state.gmap[groupId];
}

// Every tab of every window in its shared group (after a restart or a rebuild).
export async function applyAllGroups() {
  for (const w of await syncedWindows()) {
    for (const t of w.tabs) {
      const vid = vidOf(t.id);
      if (vid) await applyGroup(t.id, state.vtabs[vid].group);
    }
  }
}

// Shared groups from the windows' own groups (switched on for the first time). Groups with
// the same name and colour in different windows become one.
export async function adoptGroups(wins) {
  const byLook = {};
  for (const w of wins) {
    for (const t of w.tabs) {
      const vid = vidOf(t.id);
      if (!vid || t.groupId === NONE || state.vtabs[vid].realTabId !== t.id) continue;
      if (!state.gmap[t.groupId]) {
        const g = await chrome.tabGroups.get(t.groupId).catch(() => null);
        if (!g) continue;
        const look = g.title ? g.title + '|' + g.color : null;
        const gid = (look && byLook[look]) || ('g' + state.nextGid++);
        state.groups[gid] ||= propsOf(g);
        state.gmap[t.groupId] = gid;
        if (look) byLook[look] = gid;
      }
      state.vtabs[vid].group = state.gmap[t.groupId];
    }
  }
}
