import { createSSEStream, logger } from '@@browser-hand/engine-shared/util';
import type {
  IntentionResult,
  ScannerResult,
  VectorResult,
  AbstractorResult,
  RunnerResult,
  PipelineResult,
  PipelineOptions,
  SSEEventType,
} from '@@browser-hand/engine-shared/type';
import {
  parseIntention,
  scanPage,
  vectorize,
  abstract,
  run,
} from './layers';

const log = (msg: string, meta?: unknown) => logger.info('pipeline', msg, meta);

function emit(
  send: (event: SSEEventType, data: unknown) => void,
  type: SSEEventType,
  data: unknown,
) {
  send(type, data);
}

function extractTargetUrl(intention: IntentionResult): string | null {
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

export async function runPipeline(
  question: string,
  sessionId: string,
  options: PipelineOptions = {},
): Promise<{
  stream: ReadableStream<Uint8Array>;
  result: Promise<PipelineResult>;
}> {
  const { stream, send, close } = createSSEStream();

  const result = (async () => {
    try {
      const intention = await parseIntention(question, {
        onDelta: (delta) => {
          emit(send, 'delta', { step: 'intention', data: delta });
        },
        ondeltaDone: (thinking) => {
          emit(send, 'delta_done', { step: 'intention', data: thinking });
        },
      });
      emit(send, 'completed', { step: 'intention', data: intention });

      const targetUrl = extractTargetUrl(intention);
      if (!targetUrl) {
        throw new Error('未找到目标 URL');
      }

      const scan: ScannerResult = await scanPage(targetUrl, {
        pageId: 'p0',
        timeout: 30_000,
      });
      emit(send, 'completed', { step: 'scanner', data: scan });

      const vector: VectorResult = await vectorize(scan, intention, { topK: 10, minScore: 0.1 });
      emit(send, 'completed', { step: 'vector', data: vector });

      const abstractor: AbstractorResult = await abstract(intention, vector, {
        onDelta: (delta) => {
          emit(send, 'delta', { step: 'abstractor', data: delta });
        },
        ondeltaDone: (thinking) => {
          emit(send, 'delta_done', { step: 'abstractor', data: thinking });
        },
      });
      emit(send, 'completed', { step: 'abstractor', data: abstractor });

      const runner: RunnerResult = await run(targetUrl, abstractor, vector, {
        headless: options.headless ?? true,
        stepDelay: 500,
        screenshotPerStep: false,
        actionTimeout: 10_000,
      });
      emit(send, 'completed', { step: 'runner', data: runner });

      const pipelineResult: PipelineResult = {
        intention,
        scan,
        vector,
        abstractor,
        runner,
      };

      emit(send, 'done', { step: 'pipeline', data: { success: true, sessionId } });
      close();
      return pipelineResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('pipeline error', message);
      emit(send, 'done', { step: 'pipeline', data: { success: false, sessionId, error: message } });
      close();
      throw error;
    }
  })();

  return { stream, result };
}
