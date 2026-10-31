// Fills every [data-i18n] element with its message from _locales.
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = chrome.i18n.getMessage(el.dataset.i18n);
document.documentElement.lang = chrome.i18n.getUILanguage();
