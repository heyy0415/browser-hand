/** Layer 5: Runner — 事件驱动重入状态机（v2.0 索引格式 + 突变检测） */

import type { Page, BrowserContext } from 'playwright';
import { logger } from '../llm';
import { scanPageFromPlaywrightPage } from './scanner';
import { vectorGateway, type VectorCallbacks } from './vector';
import { abstract, type AbstractCallbacks } from './abstractor';
import type {
  FlowStep,
  ElementMap,
  RunnerResult,
  RunnerOptions,
  StepResult,
  ExtractedContent,
  TextResult,
  RunnerError,
  MutationResult,
  StateChangeRecord,
  ActionType,
  ScannerResult,
  VectorGatewayResult,
  AbstractorResult,
} from '../types';

const log = (msg: string, meta?: unknown) => logger.info('runner', msg, meta);

const MAX_SELF_HEAL_RETRIES = 2;
const MAX_REENTRY_ROUNDS = 5;

// ═══════════════════════════════════════════════════════════════════════
// 伪代码解析（v2.0 适配 [index] 格式）
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
  const inner = m[2];
  const args: string[] = [];

  // 逐段解析参数：[index] / 'quoted' / 裸值
  let remaining = inner;
  while (remaining.length > 0) {
    remaining = remaining.trim();

    // [index] 格式
    const indexMatch = remaining.match(/^\[(\d+)\]/);
    if (indexMatch) {
      args.push(indexMatch[0]);
      remaining = remaining.slice(indexMatch[0].length).trim();
      if (remaining.startsWith(',')) remaining = remaining.slice(1).trim();
      continue;
    }

    // 引号字符串
    const quoteMatch = remaining.match(/^'([^']*)'|^"([^"]*)"/);
    if (quoteMatch) {
      args.push(quoteMatch[1] ?? quoteMatch[2] ?? '');
      remaining = remaining.slice(quoteMatch[0].length).trim();
      if (remaining.startsWith(',')) remaining = remaining.slice(1).trim();
      continue;
    }

    // 裸值（数字、标识符等）
    const bareMatch = remaining.match(/^([^,)]+)/);
    if (bareMatch) {
      args.push(bareMatch[1].trim());
      remaining = remaining.slice(bareMatch[0].length).trim();
      if (remaining.startsWith(',')) remaining = remaining.slice(1).trim();
      continue;
    }

    break;
  }

  return { method, args, isComment: false };
}

function resolveActionType(method: string): ActionType {
  const map: Record<string, ActionType> = {
    navigate: 'navigate', fill: 'fill', select: 'select',
    check: 'check', uncheck: 'uncheck', scrollDown: 'scroll', scrollUp: 'scroll',
    screenshot: 'screenshot', getText: 'extract', extract: 'extract',
    open: 'navigate', wait: 'wait',
    waitForElementVisible: 'wait', scrollToElement: 'scroll', extractWithRegex: 'extract',
    extractAll: 'extract', doubleClick: 'click',
  };
  return map[method] || 'click';
}

/** 将 [index] 参数解析为真实 CSS selector */
function resolveSelectorFromArgs(
  args: string[],
  elementMap: ElementMap,
): {
  selector: string | null;
  elementIndex: number | null;
  value: string | null;
} {
  const firstArg = args[0];
  if (!firstArg) return { selector: null, elementIndex: null, value: null };

  // [index] 格式
  const indexMatch = firstArg.match(/^\[(\d+)\]$/);
  if (indexMatch) {
    const index = parseInt(indexMatch[1], 10);
    const entry = elementMap[index];
    return {
      selector: entry?.selector ?? null,
      elementIndex: index,
      value: args[1] ?? null,
    };
  }

  // 直接值（如 navigate 的 URL）
  return {
    selector: firstArg,
    elementIndex: null,
    value: args[1] ?? null,
  };
}

/** 将 Shadow DOM 穿透选择器 (>>> 语法) 转换为 Playwright 兼容格式 */
function toPlaywrightSelector(selector: string): string {
  if (!selector.includes(' >>> ')) return selector;
  return selector
    .split(' >>> ')
    .map((segment) => `css=${segment}`)
    .join(' >> ');
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

/** fill 可见性降级：原生 fill → scrollIntoView + 重试 → JS 直接设值 */
async function fillWithVisibilityFallback(page: Page, selector: string, value: string): Promise<void> {
  try {
    await page.fill(selector, value, { timeout: 5000 });
    return;
  } catch (error) {
    const msg = error instanceof Error ? error.message : '';
    if (!msg.includes('not visible') && !msg.includes('not editable')) throw error;
    log('element not visible, attempting scrollIntoView', { selector });
  }

  try {
    await page.locator(selector).scrollIntoViewIfNeeded({ timeout: 3000 });
    await page.waitForTimeout(300);
    await page.fill(selector, value, { timeout: 5000 });
    return;
  } catch {
    log('scrollIntoView failed, fallback to JS fill', { selector });
  }

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
// 智能等待
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
    return await page.evaluate(`
      (sel) => {
        const old = document.querySelector(sel);
        if (old && old.isConnected) return sel;

        const idMatch = sel.match(/^#([\\w-]+)/);
        if (idMatch) {
          const byId = document.getElementById(idMatch[1]);
          if (byId && byId.isConnected) return sel;
        }

        const tag = sel.match(/^(\\w+)/)?.[1];
        const text = sel.match(/has-text\\("([^"]+)"\\)/)?.[1];
        if (tag && text) {
          const candidates = document.querySelectorAll(tag);
          for (const c of candidates) {
            if (c.textContent?.includes(text) && c.isConnected) {
              if (c.id) return '#' + CSS.escape(c.id);
              return sel;
            }
          }
        }

        const nameMatch = sel.match(/\\[name="([^"]+)"\\]/);
        if (nameMatch) {
          const byName = document.querySelector('[name="' + nameMatch[1] + '"]');
          if (byName && byName.isConnected) return sel;
        }

        return null;
      }
    `, oldSelector);
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// v2.0 突变检测
// ═══════════════════════════════════════════════════════════════════════

/** 在浏览器中注入 MutationObserver 监听 body childList 变化 */
async function injectMutationObserver(page: Page): Promise<void> {
  await page.evaluate(`
    () => {
      window.__mutationDetected = false;
      if (window.__mutationObserver) {
        window.__mutationObserver.disconnect();
      }
      const observer = new MutationObserver(() => {
        window.__mutationDetected = true;
        observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      window.__mutationObserver = observer;
    }
  `);
}

/**
 * 点击元素并等待页面突变
 * Promise.race 语义：URL 变化 / DOM Mutation / 超时无变化
 */
async function clickAndWaitForMutation(
  page: Page,
  selector: string,
  timeout: number = 5000,
): Promise<MutationResult> {
  const urlBefore = page.url();
  const pwSelector = toPlaywrightSelector(selector);

  // 注入 MutationObserver
  await injectMutationObserver(page);

  // 执行点击
  await clickWithOverlayFallback(page, pwSelector);

  // 轮询检测突变
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    // 检查 URL 变化
    try {
      const currentUrl = page.url();
      if (currentUrl !== urlBefore) {
        return { type: 'URL_CHANGE', newUrl: currentUrl };
      }
    } catch { /* page 可能已分离 */ }

    // 检查 DOM 突变
    try {
      const detected = await page.evaluate('window.__mutationDetected');
      if (detected) {
        return { type: 'DOM_MUTATION', description: '弹窗/动态内容加载' };
      }
    } catch { /* page 可能已分离 */ }

    await page.waitForTimeout(200);
  }

  return { type: 'NONE' };
}

// ═══════════════════════════════════════════════════════════════════════
// 回调接口
// ═══════════════════════════════════════════════════════════════════════

export interface RunnerCallbacks {
  onStepStart?: (data: { lineNumber: number; code: string; action: string }) => void;
  onStepDone?: (data: { lineNumber: number; code: string; status: 'success' | 'failed' | 'skipped' | 'warning'; elapsedMs: number; screenshot?: string }) => void;
  onStepError?: (data: { lineNumber: number; code: string; error: { type: string; message: string }; retrying: boolean; retryAttempt: number }) => void;
  onExtract?: (data: { lineNumber: number; selector: string; text: string }) => void;
  onError?: (error: string) => void;
  /** SSE 事件发送器 */
  sendEvent?: (event: string, data: unknown) => void;
  /** Scanner/Vector/Abstractor 层 SSE 事件回调 */
  onScanStart?: () => void;
  onScanDone?: (result: ScannerResult) => void;
  onVectorStart?: () => void;
  onVectorGateway?: (data: { route: string; originalLines: number; filteredLines: number; compressionRatio: string }) => void;
  onVectorDone?: (result: VectorGatewayResult) => void;
  onAbstractStart?: () => void;
  onAbstractDelta?: (delta: string) => void;
  onAbstractDone?: (result: AbstractorResult) => void;
}

export interface RunnerRunOptions extends RunnerOptions {
  sessionId?: string;
  /** 最大重入轮次（默认 5） */
  maxRounds?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// v2.0 主入口：事件驱动重入状态机
// ═══════════════════════════════════════════════════════════════════════

/**
 * 事件驱动重入状态机（v2.0 Runner 主入口）
 *
 * while (remainingFlow.length > 0 && round < maxRounds):
 *   1. Scanner 扫描当前页面 → domText + elementMap
 *   2. Vector Gateway 过滤 → filteredDomText
 *   3. Abstractor 生成伪代码 → click([3]) / fill([2], 'val')
 *   4. 逐步执行伪代码:
 *      - click 步骤: clickAndWaitForMutation → 突变则 break for, 继续 while
 *      - 其他步骤: 直接执行
 *   5. 无突变 → break while (完成)
 *   6. 突变 → 计算 remainingFlow, 继续 while
 */
export async function executeWithStateControl(
  page: Page,
  _context: BrowserContext,
  initialFlow: FlowStep[],
  callbacks: RunnerCallbacks = {},
  options: RunnerRunOptions = {},
): Promise<RunnerResult> {
  const maxRounds = options.maxRounds ?? MAX_REENTRY_ROUNDS;
  const stepDelay = options.stepDelay ?? 500;
  const actionTimeout = options.actionTimeout ?? 10_000;

  const stateChanges: StateChangeRecord[] = [];
  const stepResults: StepResult[] = [];
  const textResults: TextResult[] = [];
  const screenshotResults: string[] = [];
  const extractedContents: Array<{ selector: string; content: string | string[] }> = [];
  let runnerError: RunnerError | null = null;
  let success = true;
  let totalRounds = 0;
  let executedLines = 0;
  const start = Date.now();

  let remainingFlow = [...initialFlow];

  page.setDefaultTimeout(actionTimeout);

  log('state machine start', { initialSteps: initialFlow.length, maxRounds });

  while (remainingFlow.length > 0 && totalRounds < maxRounds) {
    totalRounds++;
    log('round start', { round: totalRounds, remainingSteps: remainingFlow.length });
    callbacks.sendEvent?.('pipeline.round-start', { roundIndex: totalRounds - 1 });

    // ── 1. Scanner ──
    callbacks.onScanStart?.();
    callbacks.sendEvent?.('scanner.start', {});
    let scanResult: ScannerResult;
    try {
      scanResult = await scanPageFromPlaywrightPage(page);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log('scan failed', { round: totalRounds, error: msg });
      callbacks.onError?.(msg);
      success = false;
      runnerError = { type: 'execution-error', lineNumber: 0, code: '', message: `扫描失败: ${msg}`, screenshot: null };
      break;
    }
    callbacks.onScanDone?.(scanResult);
    callbacks.sendEvent?.('scanner.done', {});

    // ── 2. Vector Gateway ──
    callbacks.onVectorStart?.();
    callbacks.sendEvent?.('vector.start', {});
    const vectorCb: VectorCallbacks = {
      onGateway: (data) => {
        callbacks.onVectorGateway?.(data);
        callbacks.sendEvent?.('vector.gateway', data);
      },
    };
    const vectorResult = await vectorGateway(
      remainingFlow,
      scanResult.domText,
      scanResult.elementMap,
      vectorCb,
    );
    callbacks.onVectorDone?.(vectorResult);
    callbacks.sendEvent?.('vector.done', {});

    // ── 3. Abstractor ──
    callbacks.onAbstractStart?.();
    callbacks.sendEvent?.('abstractor.start', {});
    const abstractCb: AbstractCallbacks = {
      onDelta: (delta) => {
        callbacks.onAbstractDelta?.(delta);
        callbacks.sendEvent?.('abstractor.thinking', { delta });
      },
      onDeltaCompleted: (content) => {
        callbacks.sendEvent?.('abstractor.thinking', { content });
      },
      onError: (error) => {
        callbacks.sendEvent?.('abstractor.error', { error });
      },
    };
    const abstractorResult = await abstract(
      remainingFlow,
      vectorResult.filteredDomText,
      scanResult.elementMap,
      scanResult.url,
      abstractCb,
      { isSubsequentRound: totalRounds > 1 },
    );
    callbacks.onAbstractDone?.(abstractorResult);
    callbacks.sendEvent?.('abstractor.done', {});

    // ── 4. 逐步执行伪代码 ──
    const elementMap = scanResult.elementMap;
    let mutationDetected = false;
    let mutationResult: MutationResult | null = null;
    let mutationAtCodeIndex = -1;

    callbacks.sendEvent?.('runner.start', {});

    for (let i = 0; i < abstractorResult.code.length; i++) {
      const codeLine = abstractorResult.code[i];
      const { method, args, isComment } = parsePseudo(codeLine);
      const action = resolveActionType(method);
      const lineNumber = stepResults.length + 1;
      const stepStart = Date.now();

      callbacks.onStepStart?.({ lineNumber, code: codeLine, action });

      // 跳过注释行
      if (isComment) {
        stepResults.push({
          lineNumber, code: codeLine, status: 'skipped',
          action, selector: null, elementIndex: null,
          value: null, elapsedMs: Date.now() - stepStart, screenshot: null, error: null,
        });
        executedLines++;
        continue;
      }

      // 解析 [index] → 真实 selector
      const resolved = resolveSelectorFromArgs(args, elementMap);
      const selector = resolved.selector;
      const elementIndex = resolved.elementIndex;
      const pwSelector = selector ? toPlaywrightSelector(selector) : null;

      try {
        let extracted: string | string[] | undefined;
        let screenshotBuffer: string | undefined;

        // ── 特殊指令处理 ──

        if (method === 'screenshot') {
          const buffer = await page.screenshot({ fullPage: true });
          screenshotBuffer = buffer.toString('base64');
          screenshotResults.push(screenshotBuffer);

        } else if (method === 'getText' || method === 'extract' || method === 'extractAll') {
          if (pwSelector) {
            let content: string | string[] = '';
            let currentSelector = pwSelector;
            for (let retry = 0; retry <= MAX_SELF_HEAL_RETRIES; retry++) {
              try {
                content = method === 'extractAll'
                  ? await extractMultipleContent(page, currentSelector)
                  : await extractContent(page, currentSelector);
                break;
              } catch (error) {
                const msg = error instanceof Error ? error.message : '';
                if (isDetachedError(msg) && retry < MAX_SELF_HEAL_RETRIES && selector) {
                  callbacks.onStepError?.({
                    lineNumber, code: codeLine,
                    error: { type: 'element-not-found', message: msg },
                    retrying: true, retryAttempt: retry + 1,
                  });
                  const newSel = await rescanForElement(page, selector);
                  if (newSel) { currentSelector = toPlaywrightSelector(newSel); continue; }
                }
                throw error;
              }
            }
            extracted = content;
            extractedContents.push({ selector: selector || '', content });
            const text = typeof content === 'string' ? content : content.join('\n');
            textResults.push({ selector: selector || '', text, lineNumber });
            callbacks.onExtract?.({ lineNumber, selector: selector || '', text });
          }

        } else if (method === 'extractWithRegex') {
          if (pwSelector) {
            const rawText = await extractContent(page, pwSelector);
            const regex = new RegExp(args[1] || '(.+)');
            const matchResult = rawText.match(regex);
            extracted = matchResult?.[1] || rawText;
            extractedContents.push({ selector: selector || '', content: extracted });
            textResults.push({ selector: selector || '', text: extracted, lineNumber });
            callbacks.onExtract?.({ lineNumber, selector: selector || '', text: extracted });
          }

        } else if (method === 'navigate' || method === 'open') {
          await page.goto(args[0], { waitUntil: 'domcontentloaded' });

        } else if (method === 'click' || method === 'doubleClick') {
          // ── v2.0 核心：click 步骤使用 clickAndWaitForMutation 检测突变 ──
          if (pwSelector && selector) {
            const mutation = await clickAndWaitForMutation(page, selector, 5000);
            if (mutation.type !== 'NONE') {
              mutationDetected = true;
              mutationResult = mutation;
              mutationAtCodeIndex = i;

              // 记录状态变更
              const pseudoLine = abstractorResult.pseudoCode.find((p) => p.code === codeLine);
              const flowStepIdx = pseudoLine?.sourceStep ?? -1;
              stateChanges.push({
                triggeredByStepIndex: flowStepIdx,
                mutationType: mutation.type,
                reason: mutation.type === 'URL_CHANGE'
                  ? '页面跳转'
                  : (mutation.description || 'DOM 突变'),
                targetUrl: mutation.newUrl,
                remainingStepsCount: 0, // 稍后更新
              });

              // 发送 SSE 事件
              callbacks.sendEvent?.('state_change_detected', {
                type: mutation.type,
                reason: mutation.type === 'URL_CHANGE'
                  ? '页面跳转'
                  : (mutation.description || 'DOM 突变'),
                targetUrl: mutation.newUrl,
              });

              log('mutation detected, will re-enter', {
                type: mutation.type,
                step: codeLine,
                round: totalRounds,
              });

              // 记录当前步骤为成功
              stepResults.push({
                lineNumber, code: codeLine, status: 'success',
                action: 'click', selector, elementIndex, value: null,
                elapsedMs: Date.now() - stepStart, screenshot: null, error: null,
              });
              callbacks.onStepDone?.({
                lineNumber, code: codeLine, status: 'success',
                elapsedMs: Date.now() - stepStart,
              });
              executedLines++;

              // Break 内层 for，继续外层 while
              break;
            }
          } else if (pwSelector) {
            // 无 selector 映射的 click（不应发生，但做防御）
            await clickWithOverlayFallback(page, pwSelector);
          }

        } else if (method === 'fill') {
          // fill 不触发突变检测，直接执行
          if (pwSelector) {
            await fillWithVisibilityFallback(page, pwSelector, args[1] ?? '');
          }

        } else if (method === 'select') {
          // select 不触发突变检测
          if (pwSelector) {
            try {
              await page.selectOption(pwSelector, { label: args[1] ?? '' }, { timeout: 5000 });
            } catch (error) {
              const msg = error instanceof Error ? error.message : '';
              if (msg.includes('not visible')) {
                try {
                  await page.locator(pwSelector).scrollIntoViewIfNeeded({ timeout: 3000 });
                  await page.waitForTimeout(300);
                  await page.selectOption(pwSelector, { label: args[1] ?? '' }, { timeout: 5000 });
                } catch {
                  await page.evaluate(`
                    (args) => {
                      const [sel, val] = args;
                      const el = document.querySelector(sel);
                      if (el && el.tagName === 'SELECT') {
                        el.value = val;
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                      }
                    }
                  `, [pwSelector, args[1] ?? '']);
                }
              } else {
                throw error;
              }
            }
          }

        } else if (method === 'check') {
          if (pwSelector) await page.check(pwSelector);
        } else if (method === 'uncheck') {
          if (pwSelector) await page.uncheck(pwSelector);
        } else if (method === 'scrollDown') {
          await page.mouse.wheel(0, 800);
        } else if (method === 'scrollUp') {
          await page.mouse.wheel(0, -800);
        } else if (method === 'waitForElementVisible') {
          if (pwSelector) await page.waitForSelector(pwSelector, { state: 'visible', timeout: 10000 });
        } else if (method === 'scrollToElement') {
          if (pwSelector) await page.locator(pwSelector).scrollIntoViewIfNeeded({ timeout: 5000 });
        } else if (method === 'wait') {
          const waitArg = args[0];
          if (waitArg && /^\d+$/.test(waitArg)) {
            await smartWait(page, parseInt(waitArg));
          } else if (waitArg && pwSelector) {
            await page.waitForSelector(pwSelector, { state: 'visible', timeout: 10000 });
          } else {
            await smartWait(page, 2000);
          }
        } else {
          // 未知方法：尝试 click
          if (pwSelector) await clickWithOverlayFallback(page, pwSelector);
        }

        // 如果没有被 mutation break，记录成功
        if (!mutationDetected) {
          const elapsedMs = Date.now() - stepStart;
          stepResults.push({
            lineNumber, code: codeLine, status: 'success',
            action, selector, elementIndex, value: resolved.value,
            elapsedMs, screenshot: screenshotBuffer || null, error: null,
          });
          callbacks.onStepDone?.({ lineNumber, code: codeLine, status: 'success', elapsedMs, screenshot: screenshotBuffer });
          executedLines++;

          // 步骤间等待
          if (i < abstractorResult.code.length - 1) {
            await smartWait(page, stepDelay);
          }
        }

      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        success = false;

        const elapsedMs = Date.now() - stepStart;
        stepResults.push({
          lineNumber, code: codeLine, status: 'failed',
          action, selector, elementIndex, value: resolved.value,
          elapsedMs, screenshot: null, error: message,
        });

        runnerError = {
          type: /timeout/i.test(message) ? 'timeout'
            : /not found|no element/i.test(message) ? 'element-not-found'
            : 'execution-error',
          lineNumber, code: codeLine, message, screenshot: null,
        };

        callbacks.onStepError?.({
          lineNumber, code: codeLine,
          error: { type: runnerError.type, message },
          retrying: false, retryAttempt: 0,
        });

        executedLines++;
        break; // 错误时退出内层 for
      }
    }

    callbacks.sendEvent?.('runner.done', {});

    // ── 检查是否所有步骤都成功执行 ──
    if (!mutationDetected) {
      log('all steps executed, no mutation', { round: totalRounds });
      break; // 退出 while 循环
    }

    // ── Mutation: 计算剩余 flow steps ──
    const mutationPseudoLine = abstractorResult.pseudoCode.find(
      (p) => p.code === abstractorResult.code[mutationAtCodeIndex],
    );
    const completedFlowIdx = mutationPseudoLine?.sourceStep ?? 0;
    remainingFlow = remainingFlow.slice(completedFlowIdx + 1);

    // 更新最后一条 stateChange 的 remainingStepsCount
    if (stateChanges.length > 0) {
      stateChanges[stateChanges.length - 1].remainingStepsCount = remainingFlow.length;
    }

    log('re-entering with remaining flow', {
      round: totalRounds,
      remainingSteps: remainingFlow.length,
      mutationType: mutationResult?.type,
    });

    // 剩余步骤为空则完成
    if (remainingFlow.length === 0) {
      log('no remaining flow steps, done');
      break;
    }

    // 等待页面稳定后进入下一轮
    await smartWait(page, 2000);
  }

  // ── 构建结果 ──

  // 达到最大轮次仍未完成
  if (remainingFlow.length > 0 && totalRounds >= maxRounds) {
    log('max rounds reached', { maxRounds, remainingSteps: remainingFlow.length });
    success = false;
    if (!runnerError) {
      runnerError = {
        type: 'execution-error',
        lineNumber: 0,
        code: '',
        message: `达到最大重入轮次 (${maxRounds})，仍有 ${remainingFlow.length} 步未执行`,
        screenshot: null,
      };
    }
  }

  let extractedContent: ExtractedContent | null = null;
  if (textResults.length > 0 || screenshotResults.length > 0) {
    const type = textResults.length > 0 && screenshotResults.length > 0
      ? 'mixed' as const
      : textResults.length > 0 ? 'text' as const : 'screenshot' as const;
    extractedContent = { type, textResults, screenshotResults };
  }

  const totalElapsedMs = Date.now() - start;
  log('state machine done', {
    success,
    totalRounds,
    steps: stepResults.length,
    totalElapsedMs,
    stateChanges: stateChanges.length,
    extractedCount: extractedContents.length,
  });

  return {
    success,
    steps: stepResults,
    extractedContent,
    finalScreenshot: screenshotResults[screenshotResults.length - 1] || null,
    error: runnerError,
    totalElapsedMs,
    results: stepResults,
    duration: totalElapsedMs,
    extractedContents,
    stateChanges,
    totalRounds,
    executedLines,
  };
}
