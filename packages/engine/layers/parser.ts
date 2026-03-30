/** parser 层 — Extension 端页面解析，处理客户端提供的 DOM 为结构化数据 */

import { createSSEStream, logger } from '../utils';
import type { ScannerResult, ElementSnapshot } from '../types';

const log = (msg: string, meta?: unknown) => logger.info('parser', msg, meta);

/**
 * 从 DOM 元素提取语义标签和选择器
 */
function extractElementInfo(element: Element, index: number): Partial<ElementSnapshot> {
  const tag = element.tagName.toLowerCase();
  const id = element.id;
  const classes = element.className;
  
  // 生成选择器：优先使用 id，其次使用 class，最后使用 tag
  let selector = tag;
  if (id) {
    selector = `#${id}`;
  } else if (classes) {
    const classList = classes.split(' ').filter(c => c.length > 0);
    if (classList.length > 0) {
      selector = `.${classList[0]}`;
    }
  }

  // 提取语义角色
  let role: any = 'clickable';
  const ariaRole = element.getAttribute('aria-role');
  if (ariaRole) {
    role = ariaRole;
  } else if (tag === 'button') {
    role = 'button';
  } else if (tag === 'a') {
    role = 'link';
  } else if (tag === 'input') {
    const type = element.getAttribute('type') || 'text';
    if (type === 'checkbox') role = 'checkbox';
    else if (type === 'radio') role = 'radio';
    else if (type === 'file') role = 'file-upload';
    else if (type === 'date') role = 'date-picker';
    else if (type === 'range') role = 'range-slider';
    else if (type === 'color') role = 'color-picker';
    else role = 'text-input';
  } else if (tag === 'textarea') {
    role = 'textarea';
  } else if (tag === 'select') {
    role = 'select';
  } else if (tag === 'canvas') {
    role = 'canvas';
  } else if (element.contentEditable === 'true') {
    role = 'content-editable';
  }

  // 提取标签文本
  let label = '';
  if (tag === 'button' || tag === 'a') {
    label = element.textContent?.trim() || '';
  } else if (tag === 'input' || tag === 'textarea') {
    label = element.getAttribute('placeholder') || '';
  } else if (tag === 'label') {
    label = element.textContent?.trim() || '';
  }

  // 提取元素状态
  const state: Record<string, unknown> = {};
  if (tag === 'input') {
    state.checked = (element as any).checked;
    state.disabled = (element as any).disabled;
    state.value = (element as any).value;
  } else if (tag === 'select') {
    state.disabled = (element as any).disabled;
    state.value = (element as any).value;
  } else if (tag === 'button') {
    state.disabled = (element as any).disabled;
  }

  return {
    tag,
    role,
    selector,
    label,
    state,
  };
}

/**
 * 解析 Extension 端传来的页面 DOM，转换为标准的 ScannerResult
 * @param pageUrl - 页面 URL
 * @param domElements - 页面 DOM 元素数组（从 content script 收集的序列化对象）
 */
export async function parsePage(
  pageUrl: string,
  domElements: any[],
): Promise<{ stream: ReadableStream<Uint8Array>; result: Promise<ScannerResult> }> {
  const { stream, send, close } = createSSEStream();
  send('start', { message: '正在解析页面...' });
  log('start', { pageUrl, elementCount: domElements.length });

  const result = (async () => {
    try {
      // 处理 DOM 元素为结构化数据
      const elements: ElementSnapshot[] = (Array.isArray(domElements) ? domElements : []).map((el, index) => {
        // 检查是否已经是序列化的对象数据（包含 uid、tag 等字段）
        if (el && typeof el === 'object' && ('uid' in el || 'tag' in el)) {
          // 直接使用序列化的对象数据
          return {
            uid: el.uid || `p0:0:${index}`,
            tag: el.tag || 'div',
            role: el.role || 'clickable',
            selector: el.selector || '',
            label: el.label || '',
            state: el.state || {},
            framePath: el.framePath || [],
          };
        } else if (el && typeof el === 'object' && 'tagName' in el) {
          // 如果是 DOM 元素对象（但在 Node.js 中不会出现），使用 extractElementInfo
          const info = extractElementInfo(el, index);
          return {
            uid: `p0:0:${index}`,
            tag: info.tag || 'div',
            role: info.role as any || 'clickable',
            selector: info.selector || '',
            label: info.label || '',
            state: info.state || {},
            framePath: [],
          };
        } else {
          // 默认处理
          return {
            uid: `p0:0:${index}`,
            tag: 'div',
            role: 'clickable',
            selector: '',
            label: '',
            state: {},
            framePath: [],
          };
        }
      });

      const parserResult: ScannerResult = {
        url: pageUrl,
        elements,
      };

      log('done', { elementCount: elements.length });
      send('done', { success: true });
      close();
      return parserResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', msg);
      send('error', { message: msg });
      send('done', { success: false });
      close();
      throw err;
    }
  })();

  return { stream, result };
}
