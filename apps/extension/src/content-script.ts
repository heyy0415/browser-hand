/**
 * Content Script - 备用脚本注入方案
 */

console.log('[content-script] 已加载, URL:', window.location.href);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'EXECUTE_SCRIPT') {
    try {
      console.log('[content-script] 收到执行请求，脚本长度:', request.code?.length);

      // 在 ISOLATED world 中直接通过 chrome.scripting 风格执行
      // 但由于 content script 是 ISOLATED world，这里用 Function 构造
      // 注意：这仍然受 CSP 限制，仅作为备用方案
      const fn = new Function(request.code);
      fn();

      sendResponse({ success: true });
    } catch (err) {
      console.error('[content-script] 执行失败:', err);
      sendResponse({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return true; // 保持消息通道开放
});
