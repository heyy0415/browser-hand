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
      emit(send, 'start', { sessionId });

      emit(send, 'start', { step: 'intention' });
      const intention = await parseIntention(question, {
        onDelta: (accumulated) => {
          emit(send, 'delta', { step: 'intention', data: accumulated });
        },
        ondeltaDone: (content) => {
          emit(send, 'delta_done', { step: 'intention', data: content });
        },
      });
      emit(send, 'completed', { step: 'intention', data: intention });

      const targetUrl = extractTargetUrl(intention);
      if (!targetUrl) {
        throw new Error('未找到目标 URL');
      }

      emit(send, 'start', { step: 'scanner' });
      const scan: ScannerResult = await scanPage(targetUrl, {
        pageId: 'p0',
        timeout: 30_000,
        onProgress: (message) => emit(send, 'delta', { step: 'scanner', message }),
      });
      emit(send, 'completed', { step: 'scanner', data: { url: scan.url, elements: scan.elements } });

      emit(send, 'start', { step: 'vector' });
      const vector: VectorResult = await vectorize(scan, intention, { topK: 10, minScore: 0.1 });
      emit(send, 'completed', { step: 'vector', data: vector });

      emit(send, 'start', { step: 'abstractor' });
      const abstractor: AbstractorResult = await abstract(intention, vector);
      for (const line of abstractor.code) {
        emit(send, 'delta', { step: 'abstractor', data: line });
      }
      emit(send, 'completed', { step: 'abstractor', data: abstractor });

      emit(send, 'start', { step: 'runner' });
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

      emit(send, 'done', { success: true, sessionId });
      close();
      return pipelineResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('pipeline error', message);
      emit(send, 'error', { message });
      emit(send, 'done', { success: false, sessionId });
      close();
      throw error;
    }
  })();

  return { stream, result };
}
