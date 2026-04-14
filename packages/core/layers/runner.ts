/** Layer 5: Runner — 执行伪代码并返回结果（智能等待与自愈） */

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
  StepResult,
  ExtractedContent,
  TextResult,
  RunnerError,
} from '../types';
import { getStepCategory, StepCategory } from '../types';

const log = (msg: string, meta?: unknown) => logger.info('runner', msg, meta);

const MAX_SELF_HEAL_RETRIES = 2;

// ═══════════════════════════════════════════════════════════════════════
// 伪代码解析
// ═══════════════════════════════════════════════════════════════════════

type ParsedPseudo = { method: string; args: string[]; isComment: boolean };

function parsePseudo(line: string): ParsedPseudo {
  const trimmed = line.trim();

  // 注释行：# WARNING: ...
  if (trimmed.startsWith('#')) {
    return { method: 'comment', args: [trimmed], isComment: true };
  }

  const m = trimmed.match(/^([a-zA-Z][a-zA-Z0-9]*)\((.*)\)$/);
  if (!m) return { method: 'comment', args: [trimmed], isComment: true };

  const method = m[1];
  const args: string[] = [];
  const inner = m[2];

  // 先尝试提取引号参数：'value' 或 "value"
  const quotedRe = /'([^']*)'|"([^"]*)"/g;
  let hasQuotedArgs = false;
  for (const hit of inner.matchAll(quotedRe)) {
    args.push(hit[1] ?? hit[2] ?? '');
    hasQuotedArgs = true;
  }

  // 无引号参数时，按逗号分割提取裸值（如 wait(2000)、scrollDown()）
  if (!hasQuotedArgs && inner.length > 0) {
    for (const part of inner.split(',')) {
      const val = part.trim();
      if (val) args.push(val);
    }
  }

  return { method, args, isComment: false };
}

function resolveActionType(method: string): ActionResultType {
  const map: Record<string, ActionResultType> = {
    navigate: 'navigate', fill: 'fill', select: 'select',
    check: 'check', uncheck: 'check', scrollDown: 'scroll', scrollUp: 'scroll',
    screenshot: 'screenshot', getText: 'extract', extract: 'extract',
    open: 'navigate', wait: 'wait',
    waitForElementVisible: 'wait', scrollToElement: 'scroll', extractWithRegex: 'extract',
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

    log('fallback to JS click', { selector });
    await page.evaluate(`(sel) => { document.querySelector(sel)?.click(); }`, selector);
  }
}

/**
 * fill 操作的可见性降级：
 * 1. 先尝试原生 page.fill
 * 2. 如果元素不可见，尝试 scrollIntoViewIfNeeded 后重试
 * 3. 最终降级到 JS 直接设置 value + 触发 input 事件
 */
async function fillWithVisibilityFallback(page: Page, selector: string, value: string): Promise<void> {
  try {
    await page.fill(selector, value, { timeout: 5000 });
    return;
  } catch (error) {
    const msg = error instanceof Error ? error.message : '';
    if (!msg.includes('not visible') && !msg.includes('not editable')) throw error;

    log('element not visible, attempting scrollIntoView', { selector });
  }

  // 尝试滚动到可见区域后重试
  try {
    await page.locator(selector).scrollIntoViewIfNeeded({ timeout: 3000 });
    await page.waitForTimeout(300);
    await page.fill(selector, value, { timeout: 5000 });
    return;
  } catch {
    log('scrollIntoView failed, fallback to JS fill', { selector });
  }

  // 最终降级：JS 直接设置 value 并触发 input/change 事件
  await page.evaluate(`
    (args) => {
      const [sel, val] = args;
      const el = document.querySelector(sel);
      if (!el) throw new Error('Element not found: ' + sel);

      el.removeAttribute('readonly');
      el.removeAttribute('disabled');

      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set;

      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, val);
      } else {
        el.value = val;
      }

      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  `, [selector, value]);
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
// 智能等待（替代硬等待）
// ═══════════════════════════════════════════════════════════════════════

async function smartWait(page: Page, ms?: number): Promise<void> {
  try {
    await page.waitForLoadState('networkidle', { timeout: ms ? Math.min(ms, 5000) : 2000 });
  } catch {
    // networkidle 超时，静默继续
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 元素自愈机制
// ═══════════════════════════════════════════════════════════════════════

function isDetachedError(msg: string): boolean {
  return /not attached|detached|not found|no element|disconnected/i.test(msg);
}

async function rescanForElement(page: Page, oldSelector: string): Promise<string | null> {
  try {
    return await page.evaluate((sel) => {
      const old = document.querySelector(sel);
      if (old && old.isConnected) return sel;

      // 从旧 selector 中提取特征寻找替代
      const idMatch = sel.match(/^#([\w-]+)/);
      if (idMatch) {
        const byId = document.getElementById(idMatch[1]);
        if (byId && byId.isConnected) return sel;
      }

      const tag = sel.match(/^(\w+)/)?.[1];
      const text = sel.match(/has-text\("([^"]+)"\)/)?.[1];
      if (tag && text) {
        const candidates = document.querySelectorAll(tag);
        for (const c of candidates) {
          if (c.textContent?.includes(text) && c.isConnected) {
            if (c.id) return '#' + CSS.escape(c.id);
            return sel; // 无法生成更好 selector，返回原始
          }
        }
      }

      // 尝试通过 name 属性匹配
      const nameMatch = sel.match(/\[name="([^"]+)"\]/);
      if (nameMatch) {
        const byName = document.querySelector(`[name="${nameMatch[1]}"]`);
        if (byName && byName.isConnected) return sel;
      }

      return null;
    }, oldSelector);
  } catch {
    return null;
  }
}

/** 执行单步伪代码，带自愈重试 */
async function executeStep(page: Page, method: string, args: string[]): Promise<void> {
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
      await fillWithVisibilityFallback(page, args[0], args[1] ?? '');
      break;
    case 'select':
      try {
        await page.selectOption(args[0], { label: args[1] ?? '' }, { timeout: 5000 });
      } catch (error) {
        const msg = error instanceof Error ? error.message : '';
        if (msg.includes('not visible')) {
          log('select element not visible, attempting scrollIntoView', { selector: args[0] });
          try {
            await page.locator(args[0]).scrollIntoViewIfNeeded({ timeout: 3000 });
            await page.waitForTimeout(300);
            await page.selectOption(args[0], { label: args[1] ?? '' }, { timeout: 5000 });
          } catch {
            log('select scrollIntoView failed, fallback to JS', { selector: args[0] });
            await page.evaluate(`
              (args) => {
                const [sel, val] = args;
                const el = document.querySelector(sel);
                if (el && el.tagName === 'SELECT') {
                  el.value = val;
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }
              }
            `, [args[0], args[1] ?? '']);
          }
        } else {
          throw error;
        }
      }
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
      // screenshot 在外层处理 buffer
      await page.screenshot({ fullPage: true });
      break;
    case 'waitForElementVisible':
      await page.waitForSelector(args[0], { state: 'visible', timeout: 10000 });
      break;
    case 'scrollToElement':
      await page.locator(args[0]).scrollIntoViewIfNeeded({ timeout: 5000 });
      break;
    case 'getText':
    case 'extract':
      // 在外层处理 extractedContent
      await page.textContent(args[0]);
      break;
    case 'extractWithRegex': {
      // 在外层处理
      const rawText = await extractContent(page, args[0]);
      const regex = new RegExp(args[1] || '(.+)');
      rawText.match(regex); // 仅执行匹配，结果在外层收集
      break;
    }
    case 'wait': {
      const waitArg = args[0];
      if (waitArg && /^\d+$/.test(waitArg)) {
        // 数字参数：智能等待 networkidle，上限取 min(输入值, 5000)
        await smartWait(page, parseInt(waitArg));
      } else if (waitArg) {
        // 非数字参数视为 selector：waitForSelector
        await page.waitForSelector(waitArg, { state: 'visible', timeout: 10000 });
      } else {
        await smartWait(page, 2000);
      }
      break;
    }
    default: {
      const selector = args[0];
      if (!selector) {
        log('unknown method without selector, skipping', { method });
        break;
      }
      await clickWithOverlayFallback(page, selector);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 回调接口
// ═══════════════════════════════════════════════════════════════════════

export interface RunnerCallbacks {
  onStep?: (index: number, total: number, codeLine: string, success: boolean, error?: string) => void;
  onError?: (error: string) => void;
  onExtraction?: (content: string | string[], selector: string) => void;

  onStepStart?: (data: { lineNumber: number; code: string; action: string }) => void;
  onStepDone?: (data: { lineNumber: number; code: string; status: 'success' | 'failed' | 'skipped' | 'warning'; elapsedMs: number; screenshot?: string }) => void;
  onStepError?: (data: { lineNumber: number; code: string; error: { type: string; message: string }; retrying: boolean; retryAttempt: number }) => void;
  onExtract?: (data: { lineNumber: number; selector: string; text: string }) => void;
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
  const stepResults: StepResult[] = [];
  const textResults: TextResult[] = [];
  const screenshotResults: string[] = [];
  const start = Date.now();
  let success = true;
  const extractedContents: Array<{ selector: string; content: string | string[] }> = [];
  let runnerError: RunnerError | null = null;

  const codeLines = abstractor.code;

  log('start', { url: targetUrl, steps: codeLines.length, headless, sessionId, needsBrowser });

  if (!needsBrowser) {
    log('skip browser', { reason: 'no interaction needed' });
    return {
      success: true,
      steps: [],
      extractedContent: null,
      finalScreenshot: null,
      error: null,
      totalElapsedMs: Date.now() - start,
      results: [],
      duration: Date.now() - start,
      extractedContents,
    };
  }

  const { browser } = await getOrCreateBrowser(sessionId, headless);

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(actionTimeout);

    // 判断伪代码中是否包含导航指令
    const hasNavigateInCode = codeLines.some((line) => {
      const { method, isComment } = parsePseudo(line);
      return !isComment && (method === 'navigate' || method === 'open');
    });

    // 仅当伪代码中没有导航指令时，才用 targetUrl 初始化页面
    // 否则由伪代码中的 navigate/open 指令驱动导航，避免双重跳转
    if (!hasNavigateInCode) {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    }

    for (let i = 0; i < codeLines.length; i++) {
      const codeLine = codeLines[i];
      const { method, args, isComment } = parsePseudo(codeLine);
      const stepCategory = resolveStepCategory(method);
      const lineNumber = i + 1;
      const stepStart = Date.now();

      callbacks.onStepStart?.({ lineNumber, code: codeLine, action: resolveActionType(method) });

      // 注释行：跳过执行，标记为 skipped
      if (isComment) {
        const elapsedMs = Date.now() - stepStart;
        stepResults.push({
          lineNumber, code: codeLine, status: 'skipped',
          action: resolveActionType(method), selector: null, value: null,
          elapsedMs, screenshot: null, error: null,
        });
        results.push({
          step: lineNumber, success: true,
          data: { type: resolveActionType(method), code: codeLine, pseudoCode: codeLine, category: stepCategory },
        });
        callbacks.onStepDone?.({ lineNumber, code: codeLine, status: 'skipped', elapsedMs });
        callbacks.onStep?.(lineNumber, codeLines.length, codeLine, true);
        continue;
      }

      try {
        let extractedContent: string | string[] | undefined;
        let screenshotBuffer: string | undefined;

        // 特殊处理需要返回值的指令
        if (method === 'screenshot') {
          const buffer = await page.screenshot({ fullPage: true });
          screenshotBuffer = buffer.toString('base64');
          screenshotResults.push(screenshotBuffer);
        } else if (method === 'getText' || method === 'extract') {
          // 带自愈的提取
          let content = '';
          for (let retry = 0; retry <= MAX_SELF_HEAL_RETRIES; retry++) {
            try {
              content = await extractContent(page, args[0]);
              break;
            } catch (error) {
              const msg = error instanceof Error ? error.message : '';
              if (isDetachedError(msg) && retry < MAX_SELF_HEAL_RETRIES) {
                callbacks.onStepError?.({
                  lineNumber, code: codeLine,
                  error: { type: 'element-not-found', message: msg },
                  retrying: true, retryAttempt: retry + 1,
                });
                const newSelector = await rescanForElement(page, args[0]);
                if (newSelector) { args[0] = newSelector; continue; }
              }
              throw error;
            }
          }
          extractedContent = content;
          extractedContents.push({ selector: args[0], content });
          textResults.push({ selector: args[0], text: content, lineNumber });
          callbacks.onExtract?.({ lineNumber, selector: args[0], text: content });
          callbacks.onExtraction?.(content, args[0]);
          log('extracted content', { selector: args[0], length: content.length });
        } else if (method === 'extractWithRegex') {
          const rawText = await extractContent(page, args[0]);
          const regex = new RegExp(args[1] || '(.+)');
          const matchResult = rawText.match(regex);
          extractedContent = matchResult?.[1] || rawText;
          extractedContents.push({ selector: args[0], content: extractedContent });
          textResults.push({ selector: args[0], text: extractedContent, lineNumber });
          callbacks.onExtract?.({ lineNumber, selector: args[0], text: extractedContent });
          callbacks.onExtraction?.(extractedContent, args[0]);
        } else if (method === 'extractAll') {
          extractedContent = await extractMultipleContent(page, args[0]);
          extractedContents.push({ selector: args[0], content: extractedContent });
          const combinedText = Array.isArray(extractedContent) ? extractedContent.join('\n') : extractedContent;
          textResults.push({ selector: args[0], text: combinedText, lineNumber });
          callbacks.onExtract?.({ lineNumber, selector: args[0], text: combinedText });
          callbacks.onExtraction?.(extractedContent, args[0]);
        } else if (method === 'wait') {
          // 智能等待替代硬等待
          const waitArg = args[0];
          if (waitArg && /^\d+$/.test(waitArg)) {
            await smartWait(page, parseInt(waitArg));
          } else if (waitArg) {
            await page.waitForSelector(waitArg, { state: 'visible', timeout: 10000 });
          } else {
            await smartWait(page, 2000);
          }
        } else if (method === 'waitForElementVisible') {
          await page.waitForSelector(args[0], { state: 'visible', timeout: 10000 });
        } else if (method === 'scrollToElement') {
          await page.locator(args[0]).scrollIntoViewIfNeeded({ timeout: 5000 });
        } else {
          // 带自愈的交互操作
          for (let retry = 0; retry <= MAX_SELF_HEAL_RETRIES; retry++) {
            try {
              await executeStep(page, method, args);
              break;
            } catch (error) {
              const msg = error instanceof Error ? error.message : '';
              if (isDetachedError(msg) && retry < MAX_SELF_HEAL_RETRIES) {
                callbacks.onStepError?.({
                  lineNumber, code: codeLine,
                  error: { type: 'element-not-found', message: msg },
                  retrying: true, retryAttempt: retry + 1,
                });
                log('self-heal retry', { method, selector: args[0], attempt: retry + 1 });
                const newSelector = await rescanForElement(page, args[0]);
                if (newSelector) {
                  args[0] = newSelector;
                  log('self-heal found new selector', { oldSelector: args[0], newSelector });
                  continue;
                }
              }
              throw error;
            }
          }
        }

        const elapsedMs = Date.now() - stepStart;
        const targetElement = vector.elements.find((el) => el.selector === args[0]);

        stepResults.push({
          lineNumber, code: codeLine, status: 'success',
          action: resolveActionType(method), selector: args[0] || null, value: args[1] ?? null,
          elapsedMs, screenshot: screenshotBuffer || null, error: null,
        });

        results.push({
          step: lineNumber, success: true,
          data: {
            type: resolveActionType(method), code: codeLine, pseudoCode: codeLine, category: stepCategory,
            target: targetElement ? {
              uid: targetElement.uid, selector: targetElement.selector,
              tag: targetElement.tag, role: targetElement.role,
            } : undefined,
            extracted: extractedContent,
          },
          ...(screenshotBuffer && { screenshot: screenshotBuffer }),
        });

        callbacks.onStepDone?.({ lineNumber, code: codeLine, status: 'success', elapsedMs, screenshot: screenshotBuffer });
        callbacks.onStep?.(lineNumber, codeLines.length, codeLine, true);

        // 步骤间智能等待（替代硬等待）
        if (i < codeLines.length - 1) {
          await smartWait(page, stepDelay);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        success = false;

        const elapsedMs = Date.now() - stepStart;

        stepResults.push({
          lineNumber, code: codeLine, status: 'failed',
          action: resolveActionType(method), selector: args[0] || null, value: args[1] ?? null,
          elapsedMs, screenshot: null, error: message,
        });

        results.push({
          step: lineNumber, success: false, error: message,
          data: { type: resolveActionType(method), code: codeLine, pseudoCode: codeLine, category: stepCategory },
        });

        runnerError = {
          type: /timeout/i.test(message) ? 'timeout' : /not found|no element/i.test(message) ? 'element-not-found' : 'execution-error',
          lineNumber, code: codeLine, message, screenshot: null,
        };

        callbacks.onStepError?.({
          lineNumber, code: codeLine,
          error: { type: runnerError.type, message },
          retrying: false, retryAttempt: 0,
        });
        callbacks.onStep?.(lineNumber, codeLines.length, codeLine, false, message);
        break;
      }
    }
  } catch (error) {
    if (!results.length) {
      const message = error instanceof Error ? error.message : String(error);
      success = false;
      runnerError = { type: 'navigation-failed', lineNumber: 0, code: '', message, screenshot: null };
      log('error', { message });
      callbacks.onError?.(message);
    }
  }

  // 结果断言（6.4）：依据 Intention 的 expectedOutcome 进行轻量级文本校验
  if (success && intention?.flow) {
    for (const step of intention.flow) {
      if (step.expectedOutcome && step.action === 'extract') {
        const extracted = extractedContents.find((e) => e.content);
        if (extracted && !String(extracted.content).includes(step.expectedOutcome)) {
          log('assertion warning', {
            expected: step.expectedOutcome,
            actual: String(extracted.content).substring(0, 100),
            step: step.target,
          });
        }
      }
    }
  }

  // 构建 ExtractedContent
  let extractedContent: ExtractedContent | null = null;
  if (textResults.length > 0 || screenshotResults.length > 0) {
    const type = textResults.length > 0 && screenshotResults.length > 0
      ? 'mixed' as const
      : textResults.length > 0 ? 'text' as const : 'screenshot' as const;
    extractedContent = { type, textResults, screenshotResults };
  }

  const totalElapsedMs = Date.now() - start;
  log('done', { success, steps: results.length, totalElapsedMs, extractedCount: extractedContents.length });

  return {
    success,
    steps: stepResults,
    extractedContent,
    finalScreenshot: screenshotResults[screenshotResults.length - 1] || null,
    error: runnerError,
    totalElapsedMs,
    results,
    duration: totalElapsedMs,
    extractedContents,
  };
}
