// Settings, kept in storage.local 'settings' (read by background/settings.js).
const followFocus = document.getElementById('followFocus');
const sites = document.getElementById('noShotSites');
const saved = document.getElementById('saved');

async function load() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  followFocus.checked = settings.followFocus !== false;
  sites.value = (settings.noShotSites || []).join('\n');
}
async function save() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  settings.followFocus = followFocus.checked;
  // "https://www.mybank.com/login" and "mybank.com" both mean mybank.com.
  settings.noShotSites = sites.value.split(/[\s,]+/).map((s) => s.trim().toLowerCase())
    .map((s) => s.replace(/^[a-z]+:\/\//, '').replace(/[/:].*$/, '').replace(/^www\./, '')).filter(Boolean);
  await chrome.storage.local.set({ settings });
  sites.value = settings.noShotSites.join('\n');
  saved.textContent = chrome.i18n.getMessage('optSaved');
  setTimeout(() => { saved.textContent = ''; }, 2000);
}
followFocus.addEventListener('change', save);
document.getElementById('save').addEventListener('click', save);
load();
