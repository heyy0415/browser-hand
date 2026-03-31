/** vector 层 — 当前默认透传成功 */

import { createSSEStream, logger } from '@@browser-hand/engine-shared/util';
import type {
  IntentionResult,
  ScannerResult,
  VectorOptions,
  VectorResult,
} from '@@browser-hand/engine-shared/type';

const log = (msg: string, meta?: unknown) => logger.info('vector', msg, meta);

export async function vectorize(
  scan: ScannerResult,
  _intention: IntentionResult,
  _options: VectorOptions = {},
): Promise<VectorResult> {
  const result: VectorResult = {
    url: scan.url,
    matches: [],
    elements: scan.elements,
    success: true,
    message: 'vector 默认执行成功（透传扫描结果）',
  };

  log('done', { success: true, elementCount: scan.elements.length });
  return result;
}

export async function processVector(
  scan: ScannerResult,
  intention: IntentionResult,
  options: VectorOptions = {},
): Promise<{ stream: ReadableStream<Uint8Array>; result: Promise<VectorResult> }> {
  const { stream, send, close } = createSSEStream();

  const result = (async () => {
    send('start', { step: 'vector' });
    const vectorResult = await vectorize(scan, intention, options);
    send('completed', { step: 'vector', data: vectorResult });
    send('done', { success: true });
    close();
    return vectorResult;
  })();

  return { stream, result };
}
