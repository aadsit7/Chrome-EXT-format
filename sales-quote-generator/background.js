// Opens the quote generator as a full page when the toolbar icon is clicked.
// The tool is too large for a popup, so no default_popup is set on the action.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
});
