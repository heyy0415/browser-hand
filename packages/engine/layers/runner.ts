/** runner 层 — 将 abstractor 伪代码转 Playwright 执行 */

import type { Page } from 'playwright';
import { logger } from '@@browser-hand/engine-shared/util';
import { getOrCreateBrowser } from '../browser-registry';
import type {
  AbstractorResult,
  VectorResult,
  RunnerResult,
  RunnerOptions,
  ActionResult,
  ActionResultType,
} from '@@browser-hand/engine-shared/type';

const log = (msg: string, meta?: unknown) => logger.info('runner', msg, meta);

type ParsedPseudo = {
  method: string;
  args: string[];
};

function parsePseudo(line: string): ParsedPseudo {
  const m = line.match(/^([a-zA-Z][a-zA-Z0-9]*)\((.*)\)$/);
  if (!m) {
    return { method: 'click', args: [line] };
  }

  const method = m[1];
  const rawArgs = m[2].trim();
  if (!rawArgs) {
    return { method, args: [] };
  }

  const args: string[] = [];
  const re = /'([^']*)'|"([^"]*)"/g;
  for (const hit of rawArgs.matchAll(re)) {
    args.push(hit[1] ?? hit[2] ?? '');
  }

  return { method, args };
}

/**
 * 尝试移除拦截 pointer events 的覆盖层
 * 先尝试找关闭按钮，找不到则将覆盖层 pointer-events 设为 none
 *
 * 使用字符串形式的 evaluate 避免非 DOM tsconfig 下的类型错误
 */
async function dismissOverlays(page: Page, targetSelector: string): Promise<boolean> {
  try {
    const script = `(selector) => {
      const target = document.querySelector(selector);
      if (!target) return false;

      const rect = target.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      const topEl = document.elementFromPoint(cx, cy);
      if (!topEl || topEl === target || target.contains(topEl)) return true;

      const overlay =
        topEl.closest('div[class*="widget"], div[class*="modal"], div[class*="overlay"], div[class*="dialog"], div[class*="popup"]') ||
        topEl;

      const closeBtn = overlay.querySelector(
        '[class*="close" i], [class*="dismiss" i], [class*="btn-close" i]',
      );
      if (closeBtn) {
        closeBtn.click();
        return true;
      }

      const style = topEl.getAttribute('style') || '';
      topEl.setAttribute('style', style + '; pointer-events: none;');
      return true;
    }`;

    return await page.evaluate(script, targetSelector);
  } catch {
    return false;
  }
}

/**
 * 执行点击操作，遇到覆盖层拦截时自动移除后重试
 */
async function clickWithOverlayFallback(page: Page, selector: string): Promise<void> {
  try {
    await page.click(selector, { timeout: 5000 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes('intercepts pointer events')) throw error;

    log('overlay detected, attempting dismiss', { selector, interceptor: msg });

    // 移除覆盖层后短暂等待让 DOM 更新
    const dismissed = await dismissOverlays(page, selector);
    if (dismissed) {
      await page.waitForTimeout(300);
      await page.click(selector, { timeout: 5000 });
      return;
    }

    // 最终降级：JS 直接触发 click 事件
    log('fallback to JS click', { selector });
    await page.evaluate(`(sel) => { document.querySelector(sel)?.click(); }`, selector);
  }
}

function resolveActionType(method: string): ActionResultType {
  if (method === 'navigate' || method === 'open') return 'navigate';
  if (method === 'fill') return 'fill';
  if (method === 'select') return 'select';
  if (method === 'check' || method === 'uncheck') return 'check';
  if (method === 'scrollDown' || method === 'scrollUp') return 'scroll';
  if (method === 'screenshot') return 'screenshot';
  if (method === 'getText') return 'extract';
  return 'click';
}

export interface RunnerCallbacks {
  onStep?: (index: number, total: number, codeLine: string, success: boolean, error?: string) => void;
  onError?: (error: string) => void;
}

export async function run(
  targetUrl: string,
  abstractor: AbstractorResult,
  vector: VectorResult,
  options: RunnerOptions & { sessionId?: string } = {},
  callbacks: RunnerCallbacks = {},
): Promise<RunnerResult> {
  const stepDelay = options.stepDelay ?? 500;
  const actionTimeout = options.actionTimeout ?? 10_000;
  const headless = options.headless ?? true;
  const sessionId = options.sessionId || 'default';

  const results: ActionResult[] = [];
  const start = Date.now();
  let success = true;

  log('start', { url: targetUrl, steps: abstractor.code.length, headless, sessionId });

  const { browser } = await getOrCreateBrowser(sessionId, headless);

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(actionTimeout);

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

    for (let i = 0; i < abstractor.code.length; i++) {
      const codeLine = abstractor.code[i];
      const { method, args } = parsePseudo(codeLine);

      try {
        switch (method) {
          case 'navigate':
          case 'open':
            await page.goto(args[0], { waitUntil: 'domcontentloaded' });
            break;
          case 'click':
            await clickWithOverlayFallback(page, args[0]);
            break;
          case 'doubleClick':
            await clickWithOverlayFallback(page, args[0]);
            break;
          case 'fill':
            await page.fill(args[0], args[1] ?? '');
            break;
          case 'select':
            await page.selectOption(args[0], { label: args[1] ?? '' });
            break;
          case 'check':
            await page.check(args[0]);
            break;
          case 'uncheck':
            await page.uncheck(args[0]);
            break;
          case 'scrollDown':
            await page.mouse.wheel(0, 800);
            break;
          case 'scrollUp':
            await page.mouse.wheel(0, -800);
            break;
          case 'screenshot':
            await page.screenshot({ fullPage: true });
            break;
          case 'getText':
            await page.textContent(args[0]);
            break;
          default:
            await clickWithOverlayFallback(page, args[0]);
            break;
        }

        results.push({
          step: i + 1,
          success: true,
          data: {
            type: resolveActionType(method),
            code: codeLine,
            pseudoCode: codeLine,
            target: vector.elements[0]
              ? {
                  uid: vector.elements[0].uid,
                  selector: vector.elements[0].selector,
                  tag: vector.elements[0].tag,
                  role: vector.elements[0].role,
                }
              : undefined,
          },
        });

        callbacks.onStep?.(i + 1, abstractor.code.length, codeLine, true);

        if (i < abstractor.code.length - 1) {
          await page.waitForTimeout(stepDelay);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        success = false;

        results.push({
          step: i + 1,
          success: false,
          error: message,
          data: {
            type: resolveActionType(method),
            code: codeLine,
            pseudoCode: codeLine,
          },
        });

        callbacks.onStep?.(i + 1, abstractor.code.length, codeLine, false, message);

        break;
      }
    }

    await context.close();
  } catch (error) {
    if (!results.length) {
      const message = error instanceof Error ? error.message : String(error);
      success = false;
      log('error', { message });
      callbacks.onError?.(message);
    }
  }

  const duration = Date.now() - start;
  log('done', { success, steps: results.length, duration });

  return {
    results,
    success,
    duration,
  };
}
