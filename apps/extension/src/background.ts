// Background service worker for BrowserHand extension

chrome.runtime.onInstalled.addListener(() => {
  console.log('BrowserHand extension installed');
});

// 点击扩展图标时打开Side Panel
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
});

// 监听来自 side panel 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_API_URL') {
    sendResponse({ url: 'http://localhost:3000' });
  }
});
