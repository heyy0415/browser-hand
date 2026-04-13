/** Layer 5: Runner — 执行伪代码并返回结果 */

import type { Page } from 'playwright';
import { logger } from '../llm';
import { getOrCreateBrowser } from '../browser-registry';
import type {
  AbstractorResult,
  VectorResult,
  RunnerResult,
  RunnerOptions,
  ActionResult,
  ActionResultType,
  IntentionResult,
} from '../types';
import { getStepCategory, StepCategory } from '../types';

const log = (msg: string, meta?: unknown) => logger.info('runner', msg, meta);

// ═══════════════════════════════════════════════════════════════════════
// 伪代码解析
// ═══════════════════════════════════════════════════════════════════════

type ParsedPseudo = { method: string; args: string[] };

function parsePseudo(line: string): ParsedPseudo {
  const m = line.match(/^([a-zA-Z][a-zA-Z0-9]*)\((.*)\)$/);
  if (!m) return { method: 'click', args: [line] };

  const method = m[1];
  const args: string[] = [];
  const re = /'([^']*)'|"([^"]*)"/g;
  for (const hit of m[2].matchAll(re)) {
    args.push(hit[1] ?? hit[2] ?? '');
  }

  return { method, args };
}

function resolveActionType(method: string): ActionResultType {
  const map: Record<string, ActionResultType> = {
    navigate: 'navigate', fill: 'fill', select: 'select',
    check: 'check', uncheck: 'check', scrollDown: 'scroll', scrollUp: 'scroll',
    screenshot: 'screenshot', getText: 'extract', extract: 'extract',
  };
  return map[method] || 'click';
}

function resolveStepCategory(method: string): StepCategory {
  const actionType = resolveActionType(method);
  switch (actionType) {
    case 'navigate': return 'navigation';
    case 'extract': return 'extraction';
    case 'screenshot':
    case 'scroll':
    case 'wait':
      return 'observation';
    default: return 'interaction';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 覆盖层处理
// ═══════════════════════════════════════════════════════════════════════

async function dismissOverlays(page: Page, selector: string): Promise<boolean> {
  try {
    return await page.evaluate(`(selector) => {
      const target = document.querySelector(selector);
      if (!target) return false;

      const rect = target.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      const topEl = document.elementFromPoint(cx, cy);
      if (!topEl || topEl === target || target.contains(topEl)) return true;

      const overlay = topEl.closest('div[class*="modal"], div[class*="overlay"], div[class*="dialog"], div[class*="popup"]') || topEl;
      const closeBtn = overlay.querySelector('[class*="close" i], [class*="dismiss" i], [class*="btn-close" i]');

      if (closeBtn) { closeBtn.click(); return true; }

      const style = topEl.getAttribute('style') || '';
      topEl.setAttribute('style', style + '; pointer-events: none;');
      return true;
    }`, selector);
  } catch {
    return false;
  }
}

async function clickWithOverlayFallback(page: Page, selector: string): Promise<void> {
  try {
    await page.click(selector, { timeout: 5000 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : '';
    if (!msg.includes('intercepts pointer events')) throw error;

    log('overlay detected, attempting dismiss', { selector });

    if (await dismissOverlays(page, selector)) {
      await page.waitForTimeout(300);
      await page.click(selector, { timeout: 5000 });
      return;
    }

    // 最终降级：JS 直接触发 click
    log('fallback to JS click', { selector });
    await page.evaluate(`(sel) => { document.querySelector(sel)?.click(); }`, selector);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 内容提取
// ═══════════════════════════════════════════════════════════════════════

async function extractContent(page: Page, selector: string): Promise<string> {
  try {
    return (await page.textContent(selector))?.trim() || '';
  } catch {
    return '';
  }
}

async function extractMultipleContent(page: Page, selector: string): Promise<string[]> {
  try {
    const elements = await page.$$(selector);
    const contents: string[] = [];
    for (const el of elements.slice(0, 10)) {
      const text = await el.textContent();
      if (text?.trim()) contents.push(text.trim());
    }
    return contents;
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 回调接口
// ═══════════════════════════════════════════════════════════════════════

export interface RunnerCallbacks {
  onStep?: (index: number, total: number, codeLine: string, success: boolean, error?: string) => void;
  onError?: (error: string) => void;
  onExtraction?: (content: string | string[], selector: string) => void;
}

export interface RunnerRunOptions extends RunnerOptions {
  sessionId?: string;
  needsBrowser?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// 意图分析
// ═══════════════════════════════════════════════════════════════════════

function analyzeIntentionNeedsBrowser(intention: IntentionResult): boolean {
  if (!intention.flow) return false;
  return intention.flow.some((step) => {
    const category = getStepCategory(step.action);
    return category === 'interaction' || category === 'navigation';
  });
}

// ═══════════════════════════════════════════════════════════════════════
// 主执行函数
// ═══════════════════════════════════════════════════════════════════════

export async function run(
  targetUrl: string,
  abstractor: AbstractorResult,
  vector: VectorResult,
  options: RunnerRunOptions = {},
  callbacks: RunnerCallbacks = {},
  intention?: IntentionResult,
): Promise<RunnerResult> {
  const stepDelay = options.stepDelay ?? 500;
  const actionTimeout = options.actionTimeout ?? 10_000;
  const needsBrowser = options.needsBrowser ?? (intention ? analyzeIntentionNeedsBrowser(intention) : true);
  const headless = options.headless ?? true;
  const sessionId = options.sessionId || 'default';

  const results: ActionResult[] = [];
  const start = Date.now();
  let success = true;
  const extractedContents: Array<{ selector: string; content: string | string[] }> = [];

  log('start', { url: targetUrl, steps: abstractor.code.length, headless, sessionId, needsBrowser });

  if (!needsBrowser) {
    log('skip browser', { reason: 'no interaction needed' });
    return { results: [], success: true, duration: Date.now() - start, extractedContents };
  }

  const { browser } = await getOrCreateBrowser(sessionId, headless);

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(actionTimeout);

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

    for (let i = 0; i < abstractor.code.length; i++) {
      const codeLine = abstractor.code[i];
      const { method, args } = parsePseudo(codeLine);
      const stepCategory = resolveStepCategory(method);

      try {
        let extractedContent: string | string[] | undefined;
        let screenshotBuffer: string | undefined;

        switch (method) {
          case 'navigate':
          case 'open':
            await page.goto(args[0], { waitUntil: 'domcontentloaded' });
            break;
          case 'click':
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
          case 'screenshot': {
            const buffer = await page.screenshot({ fullPage: true });
            screenshotBuffer = buffer.toString('base64');
            break;
          }
          case 'getText':
          case 'extract':
            extractedContent = await extractContent(page, args[0]);
            extractedContents.push({ selector: args[0], content: extractedContent });
            callbacks.onExtraction?.(extractedContent, args[0]);
            log('extracted content', { selector: args[0], length: extractedContent.length });
            break;
          case 'extractAll':
            extractedContent = await extractMultipleContent(page, args[0]);
            extractedContents.push({ selector: args[0], content: extractedContent });
            callbacks.onExtraction?.(extractedContent, args[0]);
            log('extracted multiple content', { selector: args[0], count: extractedContent.length });
            break;
          default:
            await clickWithOverlayFallback(page, args[0]);
        }

        const targetElement = vector.elements.find((el) => el.selector === args[0]);

        results.push({
          step: i + 1,
          success: true,
          data: {
            type: resolveActionType(method),
            code: codeLine,
            pseudoCode: codeLine,
            category: stepCategory,
            target: targetElement ? {
              uid: targetElement.uid,
              selector: targetElement.selector,
              tag: targetElement.tag,
              role: targetElement.role,
            } : undefined,
            extracted: extractedContent,
          },
          ...(screenshotBuffer && { screenshot: screenshotBuffer }),
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
            category: stepCategory,
          },
        });

        callbacks.onStep?.(i + 1, abstractor.code.length, codeLine, false, message);
        break;
      }
    }
  } catch (error) {
    if (!results.length) {
      const message = error instanceof Error ? error.message : String(error);
      success = false;
      log('error', { message });
      callbacks.onError?.(message);
    }
  }

  const duration = Date.now() - start;
  log('done', { success, steps: results.length, duration, extractedCount: extractedContents.length });

  return { results, success, duration, extractedContents };
}
