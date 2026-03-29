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

interface StepMessage {
  step: string;
  data: unknown;
  type: 'delta' | 'completed';
}

function sendStepMessage(
  send: (event: SSEEventType, data: unknown) => void,
  step: string,
  type: 'delta' | 'completed',
  data: unknown,
) {
  send('step' as SSEEventType, {
    step,
    data,
    type,
  } as StepMessage);
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
    log('Layer 1: Intention start');
    sendStepMessage(send, 'intention', 'delta', { message: '正在解析意图...' });

    const { parseIntention } = await import('./layers/intention');
    const intention = await parseIntention(userInput).then((r) => r.result);

    sendStepMessage(send, 'intention', 'completed', intention);
    log('Layer 1: Intention done', intention);

    // ── Layer 2: Scanner ────────────────────────────────────
    log('Layer 2: Scanner start');
    sendStepMessage(send, 'scanner', 'delta', { message: '正在扫描页面...' });

    const { scanPage } = await import('./layers/scanner');
    const url = intention.meta.startUrl ?? 'https://www.baidu.com';
    const scanner = await scanPage(url).then((r) => r.result);

    sendStepMessage(send, 'scanner', 'completed', scanner);
    log('Layer 2: Scanner done', scanner);

    // ── Layer 3: Vector（默认透传）──────────────────────────
    log('Layer 3: Vector (pass-through)');
    sendStepMessage(send, 'vector', 'delta', { message: 'Vector 层默认流转...' });

    const { processVector } = await import('./layers/vector');
    const vector = await processVector(scanner).then((r) => r.result);

    sendStepMessage(send, 'vector', 'completed', vector);
    log('Layer 3: Vector done');

    // ── Layer 4: Abstractor ─────────────────────────────────
    log('Layer 4: Abstractor start');
    sendStepMessage(send, 'abstractor', 'delta', { message: '正在生成动作计划...' });

    const { generateAbstractor } = await import('./layers/abstractor');
    const abstractor = await generateAbstractor(intention, scanner).then((r) => r.result);

    sendStepMessage(send, 'abstractor', 'completed', abstractor);
    log('Layer 4: Abstractor done', abstractor);

    // ── Layer 5: Runner（默认成功）───────────────────────────
    log('Layer 5: Runner start');
    sendStepMessage(send, 'runner', 'delta', { message: '正在执行动作...' });

    const { executeRunner } = await import('./layers/runner');
    const runner = await executeRunner(abstractor).then((r) => r.result);

    sendStepMessage(send, 'runner', 'completed', runner);
    log('Layer 5: Runner done', runner);

    send('done' as SSEEventType, { success: true, sessionId });
    close();

    return { intention, scanner, vector, abstractor, runner };
  })();

  return { stream, result };
}
