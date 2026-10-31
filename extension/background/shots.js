// Pictures of live pages, so a stand-in elsewhere shows a blurred copy of the latest view
// instead of an empty page. Stored in storage.session as 'shot:<vid>'.
import { state, run, hooks, refreshStandIns } from './state.js';
import { mayPicture } from './settings.js';

// storage.session holds about 10 MB in all, and the state lives there too: pictures get at
// most this much, the oldest dropped first.
const SHOT_BUDGET = 6 * 1024 * 1024;
let shotMeta = null; // vid -> [taken at, size]; stored as 'shotMeta' so it outlives the worker
async function loadMeta() {
  if (!shotMeta) shotMeta = (await chrome.storage.session.get('shotMeta')).shotMeta || {};
  return shotMeta;
}

const shotAt = {};       // vid -> when its picture was last taken
let pauseUntil = 0;      // the 2 s loop stays quiet around a switch (Chrome allows 2 captures a second)

export const hasFreshShot = (vid) => Date.now() - (shotAt[vid] || 0) < 2500;
export function pauseShots(ms) { pauseUntil = Date.now() + ms; }

// Just after a switch: which window to take a fresh picture of the page in, if any.
export async function refreshTarget(vid) {
  const R = await chrome.tabs.get(state.vtabs[vid]?.realTabId ?? -1).catch(() => null);
  if (!R || !R.active || !(await chrome.windows.get(R.windowId).catch(() => ({}))).focused) return null;
  return [R.windowId, vid];
}

// wait: when Chrome says "too many captures this second", wait and try once more. A switch
// passes false: it goes on with the picture it has rather than hold up the click.
export async function captureShot(windowId, vid, { wait = true } = {}) {
  if (!mayPicture(state.vtabs[vid]?.url)) return;
  let shot;
  for (let i = 0; !shot && i < (wait ? 2 : 1); i++) {
    try {
      shot = await shrink(await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 80 }));
    } catch (e) {
      // chrome:// pages can't be captured; over 2 captures a second: wait and try once more
      if (i || !/MAX_CAPTURE|quota/i.test(String(e && e.message))) return;
      await new Promise((r) => setTimeout(r, 550));
    }
  }
  if (!shot) return;
  // Captures can run alongside a switch: keep the picture only if it really shows this page.
  const R = await chrome.tabs.get(state.vtabs[vid]?.realTabId ?? -1).catch(() => null);
  if (!R || !R.active || R.windowId !== windowId) return;
  shotAt[vid] = Date.now();
  await storeShot(vid, shot);
}

async function storeShot(vid, shot) {
  const m = await loadMeta();
  m[vid] = [Date.now(), shot.length];
  let total = Object.values(m).reduce((n, [, size]) => n + size, 0);
  const drop = [];
  for (const v of Object.keys(m).sort((a, b) => m[a][0] - m[b][0])) {
    if (total <= SHOT_BUDGET) break;
    if (v === vid) continue;
    total -= m[v][1];
    delete m[v];
    drop.push('shot:' + v);
  }
  try {
    if (drop.length) await chrome.storage.session.remove(drop);
    await chrome.storage.session.set({ ['shot:' + vid]: shot, shotMeta: m });
    refreshStandIns([vid]);
  } catch {
    // Still full (e.g. a very large state): keep only this picture.
    await clearShots(vid);
    await chrome.storage.session.set({ ['shot:' + vid]: shot, shotMeta: { [vid]: m[vid] } }).catch(() => {});
    refreshStandIns([vid]);
  }
}

export async function forgetShot(vid) {
  const m = await loadMeta();
  delete m[vid];
  delete shotAt[vid];
  await chrome.storage.session.remove('shot:' + vid);
  await chrome.storage.session.set({ shotMeta: m }).catch(() => {});
  refreshStandIns([vid]);
}

// Remove every picture (but `keep`), including any the index lost track of.
export async function clearShots(keep) {
  const keys = Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith('shot:') && k !== 'shot:' + keep);
  await chrome.storage.session.remove(keys);
  for (const v of Object.keys(await loadMeta())) if (v !== keep) { delete shotMeta[v]; delete shotAt[v]; }
  await chrome.storage.session.set({ shotMeta }).catch(() => {});
}
// The state must always fit: when saving it hits the quota, the pictures make room.
hooks.freeSpace = () => clearShots();

// Retina captures are twice the size the stand-in needs, and it is shown blurred anyway:
// scale down to keep storage small.
async function shrink(dataUrl) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const w = Math.min(bmp.width, 1280);
  if (w === bmp.width) return dataUrl;
  const h = Math.round(bmp.height * w / bmp.width);
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return 'data:image/jpeg;base64,' + btoa(bin);
}

// Keep a fresh picture of the page you're on while another window is showing its stand-in
// (side by side). When none is, the picture taken as the page leaves is enough.
// The capture itself runs outside the event queue, so a click never waits behind it.
export function startShotLoop() {
  setInterval(async () => {
    let job = null;
    await run(async () => {
      const w = await chrome.windows.getLastFocused().catch(() => null);
      if (!w || !w.focused || Date.now() < pauseUntil) return;
      const [t] = await chrome.tabs.query({ active: true, windowId: w.id });
      const vid = t && t.status === 'complete' && Object.keys(state.vtabs).find((v) => state.vtabs[v].realTabId === t.id);
      if (!vid) return;
      const shown = (await chrome.tabs.query({ active: true })).some((x) => x.windowId !== w.id && state.ph[x.id] === vid);
      if (shown) job = [w.id, vid];
    });
    if (job) await captureShot(...job);
  }, 2000);
}
