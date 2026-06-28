// background.js — service worker for Sharon (Manifest V3).
//
// Its only job: make clicking the toolbar icon open Sharon's side panel.

function enableOpenOnClick() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err) => console.warn("Sharon: setPanelBehavior failed", err));
  }
}

chrome.runtime.onInstalled.addListener(enableOpenOnClick);
chrome.runtime.onStartup.addListener(enableOpenOnClick);
