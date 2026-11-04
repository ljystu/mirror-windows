// A group tab that isn't loaded yet (background/saved.js). It shows the page's title and
// icon in the tab strip; once you open it, the background swaps it for the page at its
// first address.
const params = new URLSearchParams(location.search);
const url = params.get('u') || '';
document.title = params.get('t') || url || ' ';
if (url) {
  const icon = new URL(chrome.runtime.getURL('/_favicon/'));
  icon.searchParams.set('pageUrl', url);
  icon.searchParams.set('size', '32');
  document.getElementById('icon').href = icon.toString();
}

function ask(explicit) {
  chrome.runtime.sendMessage({ type: 'openSaved', explicit }).catch(() => {});
}
// Showing in the window you're using: open it. (The background double-checks.)
async function openIfShown() {
  if (document.visibilityState !== 'visible') return;
  try { if (!(await chrome.windows.getCurrent()).focused) return; } catch {}
  ask(false);
}
openIfShown();
document.addEventListener('visibilitychange', openIfShown);
window.addEventListener('focus', openIfShown);
setInterval(openIfShown, 2000); // a fallback, like the stand-ins
document.addEventListener('mousedown', () => ask(true));
document.addEventListener('keydown', (e) => { if (!e.metaKey && !e.ctrlKey && !e.altKey) ask(true); });
