/** vector 层 — 向量分析层，默认透传，固定返回执行成功 */

import { createSSEStream, logger } from '../utils';
import type { ScannerResult, VectorResult } from '../types';

const log = (msg: string, meta?: unknown) => logger.info('vector', msg, meta);

/** Vector 层默认透传，直接将 Scanner 结果作为成功结果返回 */
export async function processVector(
  scannerResult: ScannerResult,
): Promise<{ stream: ReadableStream<Uint8Array>; result: Promise<VectorResult> }> {
  const { stream, send, close } = createSSEStream();
  send('start', { message: 'Vector 层默认流转...' });
  log('start', scannerResult);

  // 默认执行成功，直接透传 Scanner 结果
  const result: VectorResult = { ...scannerResult };

  const promise = new Promise<VectorResult>((resolve) => {
    setTimeout(() => {
      log('done', result);
      send('done', { success: true });
      close();
      resolve(result);
    }, 50);
  });

  return { stream, result: promise };
}
