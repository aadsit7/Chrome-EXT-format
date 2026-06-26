// Bookmarks Buddy — service worker (Manifest V3)
//
// The toolbar icon has no popup. Instead, clicking it opens the side panel.
// We set that behavior both on install and on every service-worker startup so
// it keeps working after the worker is reloaded/recycled.

function enableOpenOnClick() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
}

// Runs once when the extension is installed or updated.
chrome.runtime.onInstalled.addListener(() => {
  enableOpenOnClick();
});

// Runs whenever the service worker spins back up.
enableOpenOnClick();
