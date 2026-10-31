// Shows the background's debug data and saves it as a file (no downloads permission needed).
let json = '';
chrome.runtime.sendMessage({ type: 'dump' }).then((dump) => {
  json = JSON.stringify(dump, null, 2);
  document.getElementById('out').textContent = json;
});
document.getElementById('save').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = 'debug.json';
  a.click();
});
