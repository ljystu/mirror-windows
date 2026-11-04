// The choices on the settings page (storage.local 'settings'), and whether page previews
// may be taken: they need the optional "all sites" permission, which the user grants from
// the welcome or settings page.
export const settings = {
  followFocus: true, // a window getting focus brings the page there (off: only a click does)
  noShotSites: [],   // host names never pictured (their stand-ins stay dark grey)
  savedTabs: false,  // group tabs go back to their first page when collapsed or closed (saved.js)
};
export const previews = { allowed: false };

async function refresh() {
  const { settings: saved } = await chrome.storage.local.get('settings');
  Object.assign(settings, saved || {});
  previews.allowed = await chrome.permissions.contains({ origins: ['<all_urls>'] });
}
export let refreshed = refresh(); // read the settings again: wait on this before using them
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) refreshed = refresh(); });
chrome.permissions.onAdded.addListener(refresh);
chrome.permissions.onRemoved.addListener(refresh);

// May this page be pictured?
export function mayPicture(url) {
  if (!previews.allowed) return false;
  let host = '';
  try { host = new URL(url).hostname; } catch { return false; }
  return !settings.noShotSites.some((s) => host === s || host.endsWith('.' + s));
}
