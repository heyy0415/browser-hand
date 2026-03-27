/** pipeline — 五层流水线 (intention → scanner → vector → abstractor → runner) */

import { createSSEStream, logger } from './utils';
import type {
  IntentionResult,
  ScannerResult,
  VectorResult,
  AbstractorResult,
  RunnerResult,
  SSEEventType,
} from './types';

const log = (msg: string, meta?: unknown) => logger.info('pipeline', msg, meta);

function sendEvent(
  send: (event: SSEEventType, data: unknown) => void,
  step: string,
  stepNumber: number,
  message: string,
) {
  send('step_start' as SSEEventType, { step, stepNumber, message });
}

export async function runPipeline(
  userInput: string,
  sessionId: string,
): Promise<{
  stream: ReadableStream<Uint8Array>;
  result: Promise<{
    intention: IntentionResult;
    scanner: ScannerResult;
    vector: VectorResult;
    abstractor: AbstractorResult;
    runner: RunnerResult;
  }>;
}> {
  const { stream, send, close } = createSSEStream();

  const result = (async () => {
    // ── Layer 1: Intention ──────────────────────────────────
    sendEvent(send, 'intention', 1, '正在解析意图...');
    log('Layer 1: Intention start');

    const { parseIntention } = await import('./layers/intention');
    const intention = await parseIntention(userInput).then((r) => r.result);

    send('chunk' as SSEEventType, intention);
    send('step_complete' as SSEEventType, { step: 'intention', stepNumber: 1, data: intention });
    log('Layer 1: Intention done', intention);

    // ── Layer 2: Scanner ────────────────────────────────────
    sendEvent(send, 'scanner', 2, '正在扫描页面...');
    log('Layer 2: Scanner start');

    const { scanPage } = await import('./layers/scanner');
    const url = intention.meta.startUrl ?? 'https://www.baidu.com';
    const scanner = await scanPage(url).then((r) => r.result);

    send('step_complete' as SSEEventType, { step: 'scanner', stepNumber: 2, data: scanner });
    log('Layer 2: Scanner done', scanner);

    // ── Layer 3: Vector（默认透传）──────────────────────────
    sendEvent(send, 'vector', 3, 'Vector 层默认流转...');
    log('Layer 3: Vector (pass-through)');

    const { processVector } = await import('./layers/vector');
    const vector = await processVector(scanner).then((r) => r.result);

    send('step_complete' as SSEEventType, { step: 'vector', stepNumber: 3, data: vector });
    log('Layer 3: Vector done');

    // ── Layer 4: Abstractor ─────────────────────────────────
    sendEvent(send, 'abstractor', 4, '正在生成动作计划...');
    log('Layer 4: Abstractor start');

    const { generateAbstractor } = await import('./layers/abstractor');
    const abstractor = await generateAbstractor(intention, scanner).then((r) => r.result);

    for (const line of abstractor.code) {
      send('action' as SSEEventType, { code: line });
    }
    send('step_complete' as SSEEventType, { step: 'abstractor', stepNumber: 4, data: abstractor });
    log('Layer 4: Abstractor done', abstractor);

    // ── Layer 5: Runner（默认成功）───────────────────────────
    sendEvent(send, 'runner', 5, '正在执行动作...');
    log('Layer 5: Runner start');

    const { executeRunner } = await import('./layers/runner');
    const runner = await executeRunner(abstractor).then((r) => r.result);

    send('step_complete' as SSEEventType, { step: 'runner', stepNumber: 5, data: runner });
    log('Layer 5: Runner done', runner);

    send('done' as SSEEventType, { success: true, sessionId, results: runner.results });
    close();

    return { intention, scanner, vector, abstractor, runner };
  })();

  return { stream, result };
}
