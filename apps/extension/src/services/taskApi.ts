/**
 * Task API 服务 (Extension)
 * 负责与后端 /api/task 接口通信，处理流式 SSE 响应
 */

import type { SSEEvent } from '@browser-hand/engine';

const API_BASE_URL = 'http://localhost:3000';

export interface TaskStreamOptions {
  onEvent: (event: SSEEvent) => void;
  onError: (error: Error) => void;
  onComplete: () => void;
}

/**
 * 从当前标签页获取页面 DOM 和元素信息
 */
async function getCurrentPageInfo(): Promise<{
  pageHtml: string;
  pageUrl: string;
  pageElements: any[];
}> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab.id) throw new Error('无法获取当前标签页');

  const pageUrl = tab.url || '';

  try {
    // 使用 chrome.scripting.executeScript (Manifest V3) 获取最新的 DOM
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        try {
          const elements: any[] = [];
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_ELEMENT,
            null,
            false
          );

          let node;
          let index = 0;
          while ((node = walker.nextNode())) {
            const el = node as HTMLElement;
            
            // 安全地获取 className（处理 SVGAnimatedString 等特殊情况）
            let classNameStr = '';
            try {
              classNameStr = typeof el.className === 'string' 
                ? el.className 
                : el.className?.baseVal || '';
            } catch {
              classNameStr = '';
            }
            
            const selector = el.id
              ? '#' + el.id
              : classNameStr
                ? '.' + classNameStr.split(' ')[0]
                : el.tagName.toLowerCase();

            elements.push({
              uid: `p0:0:${index}`,
              tag: el.tagName.toLowerCase(),
              role: el.getAttribute('role') || 'clickable',
              selector: selector,
              label: el.textContent?.substring(0, 100) || el.getAttribute('aria-label') || '',
              state: {
                disabled: el.hasAttribute('disabled'),
                hidden: el.hidden,
              },
              framePath: [],
            });
            index++;
          }

          return {
            success: true,
            pageHtml: document.documentElement.outerHTML,
            pageElements: elements,
          };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    });

    const result = results[0]?.result;
    
    if (!result) {
      console.error('executeScript 返回空结果', { results });
      throw new Error('executeScript 返回空结果');
    }

    if (!result.success) {
      console.error('脚本执行失败', { error: result.error });
      throw new Error(`脚本执行失败: ${result.error}`);
    }

    return {
      pageHtml: result.pageHtml || '',
      pageUrl,
      pageElements: result.pageElements || [],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('获取页面信息失败', { pageUrl, error: msg });
    throw new Error(`获取页面信息失败: ${msg}`);
  }
}

/**
 * 调用任务 API 并处理流式响应
 */
export async function submitTask(
  userInput: string,
  options: TaskStreamOptions,
): Promise<void> {
  try {
    // 获取当前页面信息（确保每次都是最新的 DOM）
    let pageInfo;
    try {
      pageInfo = await getCurrentPageInfo();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '无法获取页面信息';
      console.error('获取页面 DOM 失败', err);
      throw new Error(`获取页面 DOM 失败: ${msg}`);
    }

    const { pageHtml, pageUrl, pageElements } = pageInfo;

    // 验证获取的数据
    if (!pageElements || pageElements.length === 0) {
      console.warn('警告: 页面元素为空，可能页面未完全加载', { pageUrl });
    }

    console.log('页面信息获取成功', { 
      pageUrl, 
      elementCount: pageElements.length,
      htmlLength: pageHtml.length 
    });

    const response = await fetch(`${API_BASE_URL}/api/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userInput,
        clientType: 'extension',
        pageHtml,
        pageElements,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('无法读取响应流');
    }

    const decoder = new TextDecoder();
    let currentEvent = 'chunk';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
          continue;
        }
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (!data) continue;

          try {
            const parsed = JSON.parse(data);
            options.onEvent({ event: currentEvent as any, data: parsed });
          } catch (err) {
            // 忽略 JSON 解析错误
          }
        }
      }
    }

    options.onComplete();
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('submitTask 错误', error);
    options.onError(error instanceof Error ? error : new Error(errorMsg));
  }
}
