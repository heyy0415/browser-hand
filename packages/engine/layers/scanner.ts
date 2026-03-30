/** scanner 层 — Web 端页面扫描，通过 Playwright 抓取 DOM 并结构化处理 */

import { chromium } from 'playwright';
import { createSSEStream, logger } from '../utils';
import type { ScannerResult, ElementSnapshot } from '../types';

const log = (msg: string, meta?: unknown) => logger.info('scanner', msg, meta);

/**
 * 从 DOM 元素提取语义标签和选择器
 */
function extractElementInfo(element: any, index: number): Partial<ElementSnapshot> {
  const tag = element.tagName?.toLowerCase() || 'div';
  const id = element.id;
  const classes = element.className;
  
  // 生成选择器：优先使用 id，其次使用 class，最后使用 tag
  let selector = tag;
  if (id) {
    selector = `#${id}`;
  } else if (classes) {
    const classList = (classes as string).split(' ').filter(c => c.length > 0);
    if (classList.length > 0) {
      selector = `.${classList[0]}`;
    }
  }

  // 提取语义角色
  let role: any = 'clickable';
  const ariaRole = element.getAttribute?.('aria-role');
  if (ariaRole) {
    role = ariaRole;
  } else if (tag === 'button') {
    role = 'button';
  } else if (tag === 'a') {
    role = 'link';
  } else if (tag === 'input') {
    const type = element.getAttribute?.('type') || 'text';
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
    label = element.getAttribute?.('placeholder') || '';
  } else if (tag === 'label') {
    label = element.textContent?.trim() || '';
  }

  // 提取元素状态
  const state: Record<string, unknown> = {};
  if (tag === 'input') {
    state.checked = element.checked;
    state.disabled = element.disabled;
    state.value = element.value;
  } else if (tag === 'select') {
    state.disabled = element.disabled;
    state.value = element.value;
  } else if (tag === 'button') {
    state.disabled = element.disabled;
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
 * 通过 Playwright 扫描页面，获取 DOM 并结构化处理
 * @param url - 要扫描的页面 URL
 * @param page - Playwright Page 对象（可选，用于测试）
 */
export async function scanPage(
  url: string,
  page?: any,
): Promise<{ stream: ReadableStream<Uint8Array>; result: Promise<ScannerResult> }> {
  const { stream, send, close } = createSSEStream();
  send('start', { message: '正在扫描页面...' });
  log('start', { url });

  const result = new Promise<ScannerResult>(async (resolve, reject) => {
    let browser: any = null;
    let localPage: any = null;

    try {
      // 如果没有传入 page 对象，则创建新的浏览器实例
      if (!page) {
        browser = await chromium.launch();
        localPage = await browser.newPage();
        page = localPage;
      }

      // 使用 Playwright 抓取页面 DOM
      await page.goto(url, { waitUntil: 'networkidle' });
      
      // 获取所有可交互的元素
      const domElements = await page.evaluate(() => {
        const elements: any[] = [];
        const selectors = [
          'button', 'a', 'input', 'textarea', 'select',
          '[role="button"]', '[role="link"]', '[onclick]',
          'label', '[contenteditable="true"]'
        ];

        const seen = new Set<Element>();
        
        for (const selector of selectors) {
          try {
            const els = document.querySelectorAll(selector);
            for (const el of els) {
              if (!seen.has(el) && el.offsetParent !== null) { // 只收集可见元素
                seen.add(el);
                elements.push({
                  tagName: el.tagName,
                  id: el.id,
                  className: el.className,
                  textContent: el.textContent?.substring(0, 100),
                  getAttribute: (name: string) => el.getAttribute(name),
                  checked: (el as any).checked,
                  disabled: (el as any).disabled,
                  value: (el as any).value,
                  contentEditable: (el as any).contentEditable,
                });
              }
            }
          } catch (e) {
            // 忽略无效的选择器
          }
        }

        return elements;
      });

      // 处理 DOM 元素为结构化数据
      const elements: ElementSnapshot[] = domElements.map((el, index) => {
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
      });

      const scannerResult: ScannerResult = {
        url,
        elements,
      };

      log('done', { elementCount: elements.length, mode: 'playwright' });
      send('done', { success: true });
      close();
      resolve(scannerResult);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', msg);
      send('error', { message: msg });
      send('done', { success: false });
      close();
      reject(err);
    } finally {
      // 清理本地创建的浏览器资源
      if (localPage) {
        await localPage.close();
      }
      if (browser) {
        await browser.close();
      }
    }
  });

  return { stream, result };
}
