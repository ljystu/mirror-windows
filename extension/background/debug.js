// Data for the debug page (Alt+Shift+D): state, recent events and every window's tabs.
// Nothing leaves the browser; the page lets you save it as a file.
import { state, LOG } from './state.js';

export async function debugDump() {
  const wins = await chrome.windows.getAll({ populate: true });
  return {
    at: new Date().toISOString(),
    version: chrome.runtime.getManifest().version,
    state,
    log: LOG,
    windows: wins.map((w) => ({
      id: w.id, type: w.type, focused: w.focused, incognito: w.incognito,
      tabs: w.tabs.map((t) => ({ id: t.id, index: t.index, active: t.active, pinned: t.pinned,
        groupId: t.groupId, discarded: t.discarded, openerTabId: t.openerTabId,
        title: t.title, url: t.url, pendingUrl: t.pendingUrl })),
    })),
  };
}
