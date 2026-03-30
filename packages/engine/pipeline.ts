// pipeline.ts

import { createSSEStream, logger } from './utils';
import type {
  IntentionResult,
  ScannerResult,
  VectorResult,
  AbstractorResult,
  RunnerResult,
  SSEEventType,
  ClientType,
} from './types';

const log = (msg: string, meta?: unknown) => logger.info('pipeline', msg, meta);

interface PipelineOptions {
  clientType?: ClientType;
  pageHtml?: string;
  pageElements?: any[];
}

/**
 * 向前端发送步骤事件
 */
function sendStream(
  send: (event: SSEEventType, data: unknown) => void,
  type: 'start' | 'delta' | 'delta_done' | 'completed' | 'error',
  data: unknown,
) {
  send(type as SSEEventType, data);
}

export async function runPipeline(
  userInput: string,
  sessionId: string,
  options: PipelineOptions = {},
): Promise<{
  stream: ReadableStream<Uint8Array>;
  result: Promise<{
    intention: IntentionResult;
  }>;
}> {
  const { stream, send, close } = createSSEStream();

  const result = (async () => {
    try {
      // ══════════════════════════════════════════
      // Layer 1: Intention（流式）
      // ══════════════════════════════════════════
      sendStream(send, 'start', '');

      const { parseIntention } = await import('./layers/intention');
      const intention = await parseIntention(userInput, {
        // 实时转发 LLM 推理过程到前端
        onDelta: (accumulated) => {
          sendStream(send, 'delta', accumulated);
        },
        ondeltaDone: (content) => {
          sendStream(send, 'delta_done', content);
        },
        onError: (error) => {
          sendStream(send, 'error', error);
        },
      });

      sendStream(send, 'completed', JSON.stringify(intention));

      // 检查意图是否有效
      if (!intention.flow || intention.flow.length === 0) {
        send('error' as SSEEventType, '无法识别用户意图');
        send('done' as SSEEventType, JSON.stringify({ success: false, sessionId }));
        close();
        throw new Error('无法识别用户意图');
      }

      // ══════════════════════════════════════════
      // 完成
      // ══════════════════════════════════════════
      close();

      return { intention };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      send('error' as SSEEventType, JSON.stringify({ message: msg }));
      send('done' as SSEEventType, JSON.stringify({ success: false, sessionId }));
      close();
      throw err;
    }
  })();

  return { stream, result };
}
