/** Pipeline — 完整的浏览器自动化流水线 */

import { createSSEStream } from './llm';
import type {
  IntentionResult,
  ScannerResult,
  VectorResult,
  AbstractorResult,
  RunnerResult,
  PipelineResult,
  PipelineOptions,
  SSEEventType,
} from './types';
import {
  parseIntention,
  scanPage,
  vectorize,
  preloadModel,
  abstract,
  run,
} from './layers';

type Emit = (event: SSEEventType, data: unknown) => void;

// ═══════════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════════

function extractTargetUrl(intention: IntentionResult): string | null {
  if (!intention.flow) return null;

  const URL_RE = /^https?:\/\/.+/i;

  for (const step of intention.flow) {
    if (['navigate', 'open', 'goto', 'visit'].includes(step.action)) {
      if (step.target && URL_RE.test(step.target)) {
        return step.target;
      }
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// Pipeline 主函数
// ═══════════════════════════════════════════════════════════════════════

export async function runPipeline(
  question: string,
  sessionId: string,
  options: PipelineOptions = {},
): Promise<{
  stream: ReadableStream<Uint8Array>;
  result: Promise<PipelineResult>;
}> {
  const { stream, send, close } = createSSEStream();
  const emit: Emit = (event, data) => send(event, data, sessionId);

  // 预加载本地模型（异步，不阻塞）
  preloadModel().catch(() => {});

  const result = (async (): Promise<PipelineResult> => {
    // ── 0. 全局开始 ──────────────────────────────────────────────
    emit('task.start', { question });

    // ── 1. Intention 层 ───────────────────────────────────────────
    emit('intention.start', { question });

    const intentionStartTime = Date.now();
    const intention = await parseIntention(question, {
      onThinking: ({ delta, accumulated }) => emit('intention.thinking', { delta, accumulated }),
      context: options.context,
      model: options.model,
    });

    if (!intention) {
      emit('task.error', { step: 'intention', message: '意图解析失败' });
      emit('task.done', { success: false, sessionId });
      close();
      return {
        intention: { status: 'out_of_scope', reply: '意图解析失败', flow: null, question: null },
        scan: null as never,
        vector: null as never,
        abstractor: null as never,
        runner: null as never,
      };
    }

    emit('intention.done', {
      status: intention.status,
      reply: intention.reply,
      flow: intention.flow,
      question: intention.question,
      elapsedMs: Date.now() - intentionStartTime,
    });

    // 非 success 状态直接结束
    if (intention.status !== 'success') {
      emit('task.done', { success: true, sessionId });
      close();
      return { intention, scan: null as never, vector: null as never, abstractor: null as never, runner: null as never };
    }

    // ── 2. Scanner 层 ─────────────────────────────────────────────
    const targetUrl = extractTargetUrl(intention);
    if (!targetUrl) {
      emit('task.error', { step: 'pipeline', message: '未在意图流程中找到目标 URL' });
      emit('task.done', { success: false, sessionId });
      close();
      return { intention, scan: null as never, vector: null as never, abstractor: null as never, runner: null as never };
    }

    emit('scanner.start', { url: targetUrl, waitForStable: true });

    let scan: ScannerResult;
    try {
      scan = await scanPage(targetUrl, {
        pageId: 'p0',
        timeout: 30_000,
        autoScroll: true,
        scanFrames: true,
        onProgress: (data) => emit('scanner.scanning', data),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit('task.error', { step: 'scanner', message });
      emit('task.done', { success: false, sessionId });
      close();
      return { intention, scan: null as never, vector: null as never, abstractor: null as never, runner: null as never };
    }

    emit('scanner.done', {
      url: scan.url,
      title: scan.title,
      totalElements: scan.elements.length,
      pageSummary: scan.pageSummary,
    });

    // ── 3. Vector 层（本地 transformer.js）─────────────────────────
    emit('vector.start', { stepIndex: 0, target: '', totalElements: scan.elements.length });

    const vector: VectorResult = await vectorize(scan, intention, {
      topK: 20,
      minScore: 0.3,
      onFiltering: (data) => emit('vector.filtering', data),
      onComputing: (data) => emit('vector.computing', data),
    });

    emit('vector.done', {
      stepIndex: 0,
      target: '',
      totalCandidates: scan.elements.length,
      afterHardFilter: vector.elements.length,
      results: vector.matches.slice(0, 5).map((m, i) => ({
        rank: i + 1,
        selector: m.element.selector,
        label: m.element.label,
        score: m.score,
        breakdown: { vectorScore: m.score, keywordScore: 0, positionalScore: 0, zoneBoost: 0 },
      })),
      elapsedMs: 0,
    });

    // ── 4. Abstractor 层 ──────────────────────────────────────────
    emit('abstractor.start', { totalSteps: intention.flow?.length ?? 0 });

    const abstractor: AbstractorResult = await abstract(intention, vector, {
      onDelta: (_delta) => {}, // Abstractor 思考过程不再推送 delta，由 abstractor.done 统一输出
      onDeltaCompleted: () => {},
      model: options.model,
    });

    emit('abstractor.done', {
      pseudoCode: abstractor.pseudoCode,
      generationMethod: abstractor.generationMethod,
      warnings: abstractor.warnings,
      elapsedMs: 0,
    });

    // ── 5. Runner 层 ──────────────────────────────────────────────
    const isHeadless = options.headless ?? false;
    emit('runner.start', { totalSteps: abstractor.code.length, headless: isHeadless });

    let runner: RunnerResult;
    try {
      runner = await run(targetUrl, abstractor, vector, {
        headless: isHeadless,
        stepDelay: 500,
        screenshotPerStep: false,
        actionTimeout: 10_000,
        sessionId,
      }, {
        onStepStart: (data) => emit('runner.step-start', data),
        onStepDone: (data) => emit('runner.step-done', data),
        onStepError: (data) => emit('runner.step-error', data),
        onExtract: (data) => emit('runner.extract', data),
        onStep: (_index, _total, _codeLine, _success, _error) => {
          // 旧版回调兼容（不发送事件）
        },
        onError: (message) => emit('task.error', { step: 'runner', message }),
      }, intention);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit('task.error', { step: 'runner', message });
      runner = {
        success: false,
        steps: [],
        extractedContent: null,
        finalScreenshot: null,
        error: { type: 'execution-error', lineNumber: 0, code: '', message, screenshot: null },
        totalElapsedMs: 0,
        results: [],
        duration: 0,
      };
    }

    emit('runner.done', {
      success: runner.success,
      steps: runner.steps.map((s) => ({ lineNumber: s.lineNumber, status: s.status, elapsedMs: s.elapsedMs })),
      extractedContent: runner.extractedContent,
      totalElapsedMs: runner.totalElapsedMs,
    });

    // ── 完成 ──────────────────────────────────────────────────────
    emit('task.done', {
      success: runner.success,
      sessionId,
      duration: runner.totalElapsedMs,
    });

    close();
    return { intention, scan, vector, abstractor, runner };
  })();

  return { stream, result };
}

// ═══════════════════════════════════════════════════════════════════════
// 导出子模块
// ═══════════════════════════════════════════════════════════════════════

export { parseIntention, scanPage, vectorize, preloadModel, abstract, run };
