// Shared state, the event queue and persistence.
//
// Model: every normal window holds one entry per "virtual tab" (vtab). Exactly one window
// holds the real tab; the others hold a lightweight stand-in (placeholder.html).
//   state.vtabs[vid]  = { realTabId, url, title, favIconUrl, pinned, group }
//   state.ph[tabId]   = vid   for every stand-in (and every parked favourite copy)
//   state.parked[tabId]      a window's own copy of a pinned favourite, standing in
//   state.closed[vid] = url  recently closed pages, so a stand-in brought back by
//                            Cmd+Shift+T can turn into its page again
//   state.groups / gmap      shared tab groups (see groups.js)
//   state.excluded           windows opened as "not mirrored" (until the browser closes)

// One object for the whole lifetime of the service worker; reset in place, never replaced,
// so every module sees the same state.
export const state = {};
let loaded = false;

export function freshState() {
  return { enabled: true, nextVid: 1, vtabs: {}, ph: {}, parked: {}, closed: {}, known: [], excluded: [], nextGid: 1, groups: {}, gmap: {} };
}
export function resetState(next = freshState()) {
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, freshState(), next);
}

// True when this service worker found no state from an earlier run in this browser session
// (browser start, extension install/update/enable): the windows must be rebuilt.
export let coldStart = false;

export async function load() {
  if (loaded) return;
  const s = await chrome.storage.session.get('state');
  coldStart = !s.state;
  resetState(s.state || freshState());
  loaded = true;
}
// Stand-ins of these pages: read your title and picture again. One small message to all
// stand-ins, each picks out its own page (cheaper than every stand-in watching storage).
const standIns = new BroadcastChannel('mirror-stand-ins');
export function refreshStandIns(vids) { if (vids.length) standIns.postMessage({ vids }); }
let shownMeta = {}; // vid -> what its stand-ins show (title, address)
function changedMeta() {
  const now = {};
  for (const [vid, vt] of Object.entries(state.vtabs)) now[vid] = (vt.title || '') + '\n' + (vt.url || '');
  const changed = Object.keys(now).filter((v) => now[v] !== shownMeta[v]);
  shownMeta = now;
  return changed;
}

async function save() {
  try {
    await chrome.storage.session.set({ state });
  } catch {
    // Out of room: the pictures go first, the state has to be saved.
    await hooks.freeSpace();
    await chrome.storage.session.set({ state });
  }
  refreshStandIns(changedMeta());
  saveLayoutSoon();
}

// Flags shared by the event handlers.
export const flags = {
  suppressAll: false, // during rebuild / restore
};

// Every handler runs one at a time, in order, against loaded state.
let queue = Promise.resolve();
export function run(fn, label = '') {
  queue = queue.then(async () => {
    await load();
    const before = JSON.stringify(state);
    // Saved even when the handler fails halfway: what it already did to the tabs is real.
    try { await fn(); } finally { if (JSON.stringify(state) !== before) await save(); }
  }).catch((e) => {
    console.error('[mirror]', e);
    log('error', label, String(e && e.message || e), String(e && e.stack || '').split('\n').slice(1, 4).join(' <- '));
  });
  return queue;
}

// Recent events, shown in the debug page.
export const LOG = [];
self.__mwLog = LOG; // readable from DevTools / tests
export function log(...args) {
  LOG.push(new Date().toISOString().slice(11, 23) + ' ' + args.join(' '));
  if (LOG.length > 150) LOG.shift();
}

// The shared tab list (order, address, pin) is also kept on disk, so after Chrome
// restarts (an update, a crash) the same tabs come back in the same order.
// Set by layout.js (it needs the window helpers); kept as a hook to avoid an import cycle.
// freeSpace is set by shots.js the same way.
let layoutTimer = 0;
export const hooks = { saveLayout: async () => {}, freeSpace: async () => {} };
let layoutDue = 0; // a page that changes its title every second mustn't put the save off forever
function saveLayoutSoon() {
  clearTimeout(layoutTimer);
  if (!layoutDue) layoutDue = Date.now() + 5000;
  layoutTimer = setTimeout(() => { layoutDue = 0; run(hooks.saveLayout); }, Math.max(0, Math.min(1000, layoutDue - Date.now())));
}

// Remember a closed page for a while (bounded), for stand-ins Cmd+Shift+T brings back.
export function rememberClosed(vid, url) {
  state.closed[vid] = url || '';
  const keys = Object.keys(state.closed);
  if (keys.length > 50) delete state.closed[keys[0]];
}
