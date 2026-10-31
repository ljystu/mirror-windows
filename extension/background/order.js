// Keeping every window's tab order the same as the window you just changed.
//
// A window is read as a row of units: a single tab, or a whole tab group. The units are put
// in place left to right, so every move lands on a boundary between units and never has to
// cut through a group (Chrome refuses that). Then the tabs inside each group are ordered.
import { state, log } from './state.js';
import { tabsCall, vidOf, getWin, syncedWindows, touch, selfMoved } from './tabs.js';
import { applyGroup, groupHere } from './groups.js';

const NONE = -1;

function unitsOf(win) {
  const units = [];
  for (const t of win.tabs) {
    const vid = vidOf(t.id);
    if (!vid) continue;
    const gid = t.groupId !== NONE ? state.gmap[t.groupId] : null;
    const last = units[units.length - 1];
    if (gid && last && last.gid === gid) last.vids.push(vid);
    else if (gid) units.push({ gid, vids: [vid] });
    else units.push({ vid });
  }
  return units;
}

const indexOf = (win, vid) => win.tabs.findIndex((t) => vidOf(t.id) === vid);
// Tabs not in the group the shared list says (pinned tabs are in none).
const misgrouped = (win) => win.tabs.filter((t) => {
  const vid = vidOf(t.id);
  if (!vid || t.pinned) return false;
  const gid = state.vtabs[vid]?.group || null;
  return gid ? state.gmap[t.groupId] !== gid : t.groupId !== NONE;
});

export async function alignWindows(srcId) {
  const wins = await syncedWindows();
  const src = wins.find((w) => w.id === srcId);
  if (!src) return;
  const units = unitsOf(src);
  const want = JSON.stringify(units);
  for (const other of wins) {
    if (other.id === srcId) continue;
    // Most of the time (a switch) nothing is out of place: leave the window alone.
    const wrong = misgrouped(other);
    if (!wrong.length && JSON.stringify(unitsOf(other)) === want) continue;
    await alignWindow(other.id, units, wrong);
  }
}

async function alignWindow(windowId, units, wrong) {
  // Every tab in its shared group first, so the units here match the ones there.
  for (const t of wrong) await applyGroup(t.id, state.vtabs[vidOf(t.id)]?.group);
  let pos = 0;
  let w = await getWin(windowId);
  for (const u of units) {
    if (u.vid) {
      const i = indexOf(w, u.vid);
      if (i < 0) continue;
      if (i !== pos) {
        const id = w.tabs[i].id;
        // Counted, not touch()ed: its one onMoved echo is ours, a drag of it right after is yours.
        selfMoved.add(id);
        await tabsCall(() => chrome.tabs.move(id, { index: pos })).catch((e) => { selfMoved.delete(id); log('align move failed', e.message); });
        w = await getWin(windowId);
      }
      pos = indexOf(w, u.vid) + 1;
      continue;
    }
    const g = await groupHere(windowId, u.gid);
    if (!g) continue;
    const first = w.tabs.findIndex((t) => t.groupId === g.id);
    if (first !== pos) {
      // Each of its tabs reports one onMoved: counted like single moves.
      const ids = w.tabs.filter((t) => t.groupId === g.id).map((t) => t.id);
      touch(g.id);
      ids.forEach((id) => selfMoved.add(id));
      await tabsCall(() => chrome.tabGroups.move(g.id, { index: pos })).catch((e) => { ids.forEach((id) => selfMoved.delete(id)); log('align group failed', e.message); });
      w = await getWin(windowId);
    }
    // Inside the group, the same order as there.
    let at = w.tabs.findIndex((t) => t.groupId === g.id);
    for (const vid of u.vids) {
      const i = indexOf(w, vid);
      if (i < 0 || w.tabs[i].groupId !== g.id) continue;
      if (i !== at) {
        const id = w.tabs[i].id;
        selfMoved.add(id);
        await tabsCall(() => chrome.tabs.move(id, { index: at })).catch((e) => { selfMoved.delete(id); log('align move failed', e.message); });
        w = await getWin(windowId);
      }
      at++;
    }
    pos = w.tabs.findIndex((t) => t.groupId === g.id) + w.tabs.filter((t) => t.groupId === g.id).length;
  }
}
