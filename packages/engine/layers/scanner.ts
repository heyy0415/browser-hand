/** scanner 层 — 页面扫描，获取 DOM 并结构化处理，默认成功 */

import { createSSEStream, logger } from '../utils';
import type { ScannerResult } from '../types';

const log = (msg: string, meta?: unknown) => logger.info('scanner', msg, meta);

/** 扫描页面（默认返回成功，模拟快照数据） */
export async function scanPage(
  url: string,
): Promise<{ stream: ReadableStream<Uint8Array>; result: Promise<ScannerResult> }> {
  const { stream, send, close } = createSSEStream();
  send('start', { message: '正在扫描页面...' });
  log('start', { url });

  // 默认返回成功，使用模拟快照数据
  const mockSnapshot: ScannerResult = {
    url,
    elements: [
      {
        uid: 'p0:0:12',
        tag: 'textarea',
        role: 'textarea',
        selector: '#chat-textarea',
        label: '',
        state: {},
        framePath: [],
      },
      {
        uid: 'p0:0:0',
        tag: 'a',
        role: 'link',
        selector: 'a:has-text("新闻")',
        label: '新闻',
        state: {},
        framePath: [],
      },
    ],
  };

  const result = new Promise<ScannerResult>((resolve) => {
    setTimeout(() => {
      log('done', mockSnapshot);
      send('done', { success: true });
      close();
      resolve(mockSnapshot);
    }, 100);
  });

  return { stream, result };
}
