/** runner 层 — 执行器层，默认返回执行成功 */

import { createSSEStream, logger } from '../utils';
import type { AbstractorResult, RunnerResult } from '../types';

const log = (msg: string, meta?: unknown) => logger.info('runner', msg, meta);

/** 执行伪代码列表（默认返回全部成功） */
export async function executeRunner(
  abstractorResult: AbstractorResult,
): Promise<{ stream: ReadableStream<Uint8Array>; result: Promise<RunnerResult> }> {
  const { stream, send, close } = createSSEStream();
  send('start', { message: '正在执行动作...' });
  log('start', abstractorResult);

  // 默认全部执行成功
  const runnerResult: RunnerResult = {
    results: abstractorResult.code.map((_, i) => ({
      step: i + 1,
      success: true,
    })),
  };

  const promise = new Promise<RunnerResult>((resolve) => {
    setTimeout(() => {
      log('done', runnerResult);
      for (const r of runnerResult.results) {
        send('action', { step: r.step, success: r.success });
      }
      send('done', { success: true });
      close();
      resolve(runnerResult);
    }, 50);
  });

  return { stream, result: promise };
}
