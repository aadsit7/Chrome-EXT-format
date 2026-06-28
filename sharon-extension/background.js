// background.js — service worker for Sharon (Manifest V3).
//
// Its jobs:
//   1. Make clicking the toolbar icon open Sharon's side panel.
//   2. Open Sharon's side panel (and wake her mic) from the keyboard shortcut.

function enableOpenOnClick() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err) => console.warn("Sharon: setPanelBehavior failed", err));
  }
}

chrome.runtime.onInstalled.addListener(enableOpenOnClick);
chrome.runtime.onStartup.addListener(enableOpenOnClick);

// Keyboard shortcut → open Sharon for the current window and set her mic live.
// If anything goes wrong we fail quietly; the toolbar icon still works.
async function activateSharon() {
  try {
    const win = await chrome.windows.getCurrent();
    const windowId = win && win.id;
    if (chrome.sidePanel && chrome.sidePanel.open && windowId != null) {
      await chrome.sidePanel.open({ windowId });
    }
  } catch (_) {
    // Couldn't open the panel — nothing more to do, the toolbar icon still works.
    return;
  }
  // Ask an already-open panel to wake the mic. A freshly-opened panel wakes the
  // mic itself on boot, so a missing receiver here is fine — swallow the error.
  try {
    await chrome.runtime.sendMessage({ type: "sharon-activate" });
  } catch (_) {
    /* no panel listening yet — it will go live on its own */
  }
}

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    if (command === "activate-sharon") activateSharon();
  });
}
