/** Pipeline — v2.0 精简流水线：Intention 解析 → navigate 处理 → 启动 Runner 状态机 */

import { createSSEStream } from './llm';
import { getOrCreateSession } from './browser-registry';
import type {
  PipelineResult,
  PipelineOptions,
  SSEEventType,
} from './types';
import { parseIntention } from './layers/intention';
import { executeWithStateControl } from './layers/runner';
import type { RunnerCallbacks, RunnerRunOptions } from './layers/runner';

type Emit = (event: SSEEventType, data: unknown) => void;

// ═══════════════════════════════════════════════════════════════════════
// Pipeline 主函数（v2.0 精简）
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

  const result = (async (): Promise<PipelineResult> => {
    // ── 0. 全局开始 ──
    emit('task.start', { question });

    // ── 1. Intention 层（只执行一次） ──
    emit('intention.start', { question });
    const intentionStartTime = Date.now();

    const intention = await parseIntention(question, {
      onThinking: ({ delta, accumulated }) => emit('intention.thinking', { delta, accumulated }),
      context: options.context,
      model: options.model,
    }, undefined);

    if (!intention) {
      emit('task.error', { step: 'intention', message: '意图解析失败' });
      emit('task.done', { success: false, sessionId });
      close();
      return {
        intention: { status: 'out_of_scope', reply: '意图解析失败', flow: null, question: null },
        runner: null as never,
        totalRounds: 0,
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
    if (intention.status !== 'success' || !intention.flow) {
      emit('task.done', { success: true, sessionId });
      close();
      return {
        intention,
        runner: null as never,
        totalRounds: 0,
      };
    }

    // ── 2. 创建浏览器会话 + 处理 navigate 步骤 ──
    const isHeadless = options.headless ?? false;
    const session = await getOrCreateSession(sessionId, isHeadless);
    const page = session.page;
    const context = session.context;

    // 处理首个 navigate 步骤
    let flowToExecute = intention.flow;
    const firstStep = intention.flow[0];
    if (firstStep && ['navigate', 'open'].includes(firstStep.action)) {
      const targetUrl = firstStep.target;
      if (targetUrl && /^https?:\/\/.+/i.test(targetUrl)) {
        emit('runner.step-start', { lineNumber: 1, code: `navigate('${targetUrl}')`, action: 'navigate' });
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        emit('runner.step-done', { lineNumber: 1, code: `navigate('${targetUrl}')`, status: 'success', elapsedMs: 0 });
        // 移除 navigate 步骤，剩余步骤由状态机执行
        flowToExecute = intention.flow.slice(1);
      }
    }

    // ── 3. 启动 Runner 状态机（内部管理 Scanner/Vector/Abstractor 重入循环） ──
    const runnerCallbacks: RunnerCallbacks = {
      // SSE 事件发送（7.5 + 7.6：vector.gateway 和 state_change_detected 通过此回调触发）
      sendEvent: (event, data) => emit(event as SSEEventType, data),
      // Runner 步骤级回调
      onStepStart: (data) => emit('runner.step-start', data),
      onStepDone: (data) => emit('runner.step-done', data),
      onStepError: (data) => emit('runner.step-error', data),
      onExtract: (data) => emit('runner.extract', data),
      onError: (message) => emit('task.error', { step: 'runner', message }),
      // Scanner/Vector/Abstractor 层 SSE 回调
      onScanStart: () => emit('scanner.start', {}),
      onScanDone: () => emit('scanner.done', {}),
      onVectorStart: () => emit('vector.start', {}),
      onVectorGateway: (data) => emit('vector.gateway', data),
      onVectorDone: () => emit('vector.done', {}),
      onAbstractStart: () => emit('abstractor.start', {}),
      onAbstractDelta: (delta) => emit('abstractor.thinking', { delta }),
      onAbstractDone: () => emit('abstractor.done', {}),
    };

    const runnerOptions: RunnerRunOptions = {
      headless: isHeadless,
      stepDelay: 500,
      actionTimeout: 10_000,
      sessionId,
      maxRounds: options.maxRounds,
    };

    const runner = await executeWithStateControl(
      page,
      context,
      flowToExecute,
      runnerCallbacks,
      runnerOptions,
    );

    // ── 4. 完成 ──
    emit('runner.done', {
      success: runner.success,
      steps: runner.steps.map((s) => ({ lineNumber: s.lineNumber, status: s.status, elapsedMs: s.elapsedMs })),
      extractedContent: runner.extractedContent,
      totalElapsedMs: runner.totalElapsedMs,
      stateChanges: runner.stateChanges,
      totalRounds: runner.totalRounds,
    });

    emit('task.done', {
      success: runner.success,
      sessionId,
      totalRounds: runner.totalRounds,
    });

    close();

    return {
      intention,
      runner,
      totalRounds: runner.totalRounds,
    };
  })();

  return { stream, result };
}
