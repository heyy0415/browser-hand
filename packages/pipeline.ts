/** Pipeline — 完整的浏览器自动化流水线 */

import { createSSEStream } from './utils/util';
import type {
  IntentionResult,
  ScannerResult,
  VectorResult,
  AbstractorResult,
  RunnerResult,
  PipelineResult,
  PipelineOptions,
  SSEEventType,
} from './utils/type';
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
  const emit: Emit = (event, data) => send(event, data);

  // 预加载本地模型（异步，不阻塞）
  preloadModel().catch(() => {});

  const result = (async (): Promise<PipelineResult> => {
    // ── 1. Intention 层 ───────────────────────────────────────────
    emit('conversation_start', { step: 'pipeline', data: { sessionId } });

    const intention = await parseIntention(question, {
      onDelta: (delta) => emit('conversation_delta', { step: 'intention', data: delta }),
      onDeltaCompleted: (thinking) => emit('conversation_delta_completed', { step: 'intention', data: thinking }),
      context: options.context,
      model: options.model,
    });

    if (!intention) {
      emit('error', { step: 'intention', data: '意图解析失败' });
      emit('conversation_done', { step: 'pipeline', data: { success: false, sessionId } });
      close();
      return {
        intention: { status: 'out_of_scope', reply: '意图解析失败', flow: null, question: null },
        scan: null as never,
        vector: null as never,
        abstractor: null as never,
        runner: null as never,
      };
    }

    emit('conversation_completed', { step: 'intention', status: intention.status, data: intention });

    // 非 success 状态直接结束
    if (intention.status !== 'success') {
      emit('conversation_done', { step: 'pipeline', data: { success: true, sessionId } });
      close();
      return { intention, scan: null as never, vector: null as never, abstractor: null as never, runner: null as never };
    }

    // ── 2. Scanner 层 ─────────────────────────────────────────────
    const targetUrl = extractTargetUrl(intention);
    if (!targetUrl) {
      emit('error', { step: 'pipeline', data: '未在意图流程中找到目标 URL' });
      emit('conversation_done', { step: 'pipeline', data: { success: false, sessionId } });
      close();
      return { intention, scan: null as never, vector: null as never, abstractor: null as never, runner: null as never };
    }

    emit('conversation_delta', { step: 'scanner', data: `正在扫描页面: ${targetUrl}` });

    let scan: ScannerResult;
    try {
      scan = await scanPage(targetUrl, {
        pageId: 'p0',
        timeout: 30_000,
        autoScroll: true,
        scanFrames: true,
        onProgress: (msg) => emit('conversation_delta', { step: 'scanner', data: msg }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit('error', { step: 'scanner', data: message });
      emit('conversation_done', { step: 'pipeline', data: { success: false, sessionId } });
      close();
      return { intention, scan: null as never, vector: null as never, abstractor: null as never, runner: null as never };
    }

    emit('conversation_completed', {
      step: 'scanner',
      status: 'success',
      data: { url: scan.url, elementCount: scan.elements.length },
    });

    // ── 3. Vector 层（本地 transformer.js）─────────────────────────
    emit('conversation_delta', { step: 'vector', data: '正在进行向量相似性检索...' });

    const vector: VectorResult = await vectorize(scan, intention);

    emit('conversation_completed', {
      step: 'vector',
      status: 'success',
      data: { url: vector.url, elementCount: vector.elements.length, message: vector.message },
    });

    // ── 4. Abstractor 层 ──────────────────────────────────────────
    emit('conversation_delta', { step: 'abstractor', data: '正在生成操作计划...' });

    const abstractor: AbstractorResult = await abstract(intention, vector, {
      onDelta: (delta) => emit('conversation_delta', { step: 'abstractor', data: delta }),
      onDeltaCompleted: (thinking) => emit('conversation_delta_completed', { step: 'abstractor', data: thinking }),
      model: options.model,
    });

    emit('conversation_completed', { step: 'abstractor', status: 'success', data: abstractor });

    // ── 5. Runner 层 ──────────────────────────────────────────────
    const isHeadless = options.headless ?? false;
    emit('conversation_delta', { step: 'runner', data: `正在执行操作（${isHeadless ? '无头' : '有头'}模式）...` });

    let runner: RunnerResult;
    try {
      runner = await run(targetUrl, abstractor, vector, {
        headless: isHeadless,
        stepDelay: 500,
        screenshotPerStep: false,
        actionTimeout: 10_000,
        sessionId,
      }, {
        onStep: (index, total, codeLine, success, error) => {
          const status = success ? '✓' : '✗';
          const detail = error ? ` | 错误: ${error}` : '';
          emit('conversation_delta', { step: 'runner', data: `${status} [${index}/${total}] ${codeLine}${detail}` });
        },
        onError: (message) => emit('error', { step: 'runner', data: message }),
      }, intention);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit('error', { step: 'runner', data: message });
      runner = { results: [], success: false, duration: 0 };
    }

    emit('conversation_completed', {
      step: 'runner',
      status: runner.success ? 'success' : 'error',
      data: runner,
    });

    // ── 完成 ──────────────────────────────────────────────────────
    emit('conversation_done', {
      step: 'pipeline',
      data: { success: runner.success, sessionId, duration: runner.duration },
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
