const params = new URLSearchParams(location.search);
const vid = params.get('vid');
const shotsEl = document.getElementById('shots');
let shown = null;

// Title and icon straight from the address, before storage is read, so a new stand-in never
// shows up in the tab strip as "chrome-extension://…" with the extension's icon.
function faviconFor(url) {
  const icon = new URL(chrome.runtime.getURL('/_favicon/'));
  icon.searchParams.set('pageUrl', url);
  icon.searchParams.set('size', '32');
  return icon.toString();
}
document.title = params.get('t') || params.get('u') || ' ';
if (params.get('u')) document.getElementById('icon').href = faviconFor(params.get('u'));

async function render() {
  // One read for both: the picture should be up as early as possible.
  const got = await chrome.storage.session.get(['state', 'shot:' + vid]);
  const state = got.state;
  const vt = state?.vtabs?.[vid];
  // No such page (any more): the background turns this stand-in back into something useful.
  if (!vt) { ready(); return; }
  if (document.title !== (vt.title || vt.url)) document.title = vt.title || vt.url;
  // The browser's own favicon cache, so the icon shows even before the site's icon loads.
  const icon = faviconFor(vt.url);
  const iconEl = document.getElementById('icon');
  if (iconEl.href !== icon) iconEl.href = icon;
  const shot = got['shot:' + vid] || '';
  if (shot !== shown) {
    const first = shown === null;
    shown = shot;
    await showShot(shot, first);
  }
  ready();
}

// Show a picture. The first one appears at once (decoded first, so there is no white
// frame); later ones fade in over the old one so the 2 s refresh doesn't jump.
async function showShot(shot, first) {
  document.documentElement.classList.toggle('noshot', !shot);
  const layer = document.createElement('div');
  layer.className = 'shot';
  if (shot) {
    const img = new Image();
    img.src = shot;
    try { await img.decode(); } catch {}
    layer.style.backgroundImage = `url(${shot})`;
  }
  const old = [...shotsEl.children];
  // Fade only while on screen; a hidden tab gets no animation frames, so swap at once.
  const fade = !first && document.visibilityState === 'visible';
  if (fade) layer.style.opacity = '0';
  shotsEl.append(layer);
  if (!fade) { old.forEach((o) => o.remove()); return; }
  requestAnimationFrame(() => requestAnimationFrame(() => { layer.style.opacity = '1'; }));
  layer.addEventListener('transitionend', () => old.forEach((o) => o.remove()), { once: true });
}

// Tell the background this stand-in has its picture up, so it can show the tab now.
let readySent = false;
function ready() {
  if (readySent) return;
  readySent = true;
  chrome.runtime.sendMessage({ type: 'ready', ms: Math.round(performance.now()) }).catch(() => {});
}

// In the window you're using this stand-in is about to be swapped for the real page, so
// it shows the page sharp and the swap is seamless. Anywhere else it eases into a blur.
// Ask Chrome whether this window is the focused one (document.hasFocus() can lag).
async function inUse() {
  if (document.visibilityState !== 'visible') return false;
  try { return (await chrome.windows.getCurrent()).focused; } catch { return document.hasFocus(); }
}
async function updateLook() {
  document.documentElement.classList.toggle('away', !(await inUse()));
}

// While this stand-in is on screen, keep asking for the real page. The background only
// does it if this is the active tab of the window you're using, so a stand-in showing in
// a window you're not using stays put.
function pullIfShown() {
  updateLook();
  if (document.visibilityState === 'visible') chrome.runtime.sendMessage({ type: 'pull' }).catch(() => {});
}

render();
// The background says when this page's title or picture changed.
new BroadcastChannel('mirror-stand-ins').onmessage = (e) => { if (e.data?.vids?.includes(vid)) render(); };
// Start sharp (it may be replacing the page you were just looking at), then blur if
// it isn't in use.
requestAnimationFrame(() => setTimeout(updateLook, 60));
pullIfShown();
document.addEventListener('visibilitychange', pullIfShown);
window.addEventListener('focus', pullIfShown);
window.addEventListener('blur', updateLook);
chrome.windows.onFocusChanged.addListener(updateLook);
setInterval(pullIfShown, 2000); // a fallback: focus and tab events normally get there first
// A click or a key press on the stand-in means you want the page (the click or key itself
// is not passed on to it).
const want = () => {
  document.documentElement.classList.remove('away');
  chrome.runtime.sendMessage({ type: 'pull', explicit: true }).catch(() => {});
};
document.addEventListener('mousedown', want);
document.addEventListener('keydown', (e) => { if (!e.metaKey && !e.ctrlKey && !e.altKey) want(); });
