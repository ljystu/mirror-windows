// The "page previews" button on the welcome and settings pages. Previews need the optional
// access to all sites (for chrome.tabs.captureVisibleTab); asking needs a click.
const ALL = { origins: ['<all_urls>'] };
const btn = document.getElementById('previews');
const status = document.getElementById('previews-status');
async function show() {
  const on = await chrome.permissions.contains(ALL);
  btn.textContent = chrome.i18n.getMessage(on ? 'previewsOff' : 'previewsOn');
  btn.classList.toggle('secondary', on);
  status.textContent = on ? chrome.i18n.getMessage('previewsAreOn') : '';
}
btn.addEventListener('click', async () => {
  if (await chrome.permissions.contains(ALL)) await chrome.permissions.remove(ALL);
  else await chrome.permissions.request(ALL);
  show();
});
show();
