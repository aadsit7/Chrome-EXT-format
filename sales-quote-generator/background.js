// Opens the quote generator in the browser side panel when the toolbar
// icon is clicked. Falls back to a full tab if the side panel API is
// unavailable (Chrome < 114).
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
} else {
  chrome.action.onClicked.addListener(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
  });
}
