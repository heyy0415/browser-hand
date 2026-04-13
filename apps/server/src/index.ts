/** server — HTTP 服务入口 */
/// <reference types="bun-types" />

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { runPipeline } from '@browser-hand/core';
import { logger } from '@browser-hand/core';

const log = (msg: string, meta?: unknown) => logger.info('server', msg, meta);
const PORT = Number(process.env.PORT) || 3000;

const app = new Hono();

app.use('*', cors());

// 健康检查
app.get('/api/health', (c) => c.json({ status: 'ok' }));

// 主流程：POST /api/task
app.post('/api/task', async (c) => {
  const body = await c.req.json<{
    question: string;
    headless?: boolean;
    sessionId?: string;
    model?: string;
    context?: Array<{ role: 'user' | 'assistant'; content: string }>;
  }>();
  const { question, headless, sessionId, model, context } = body;

  if (!question) {
    return c.json({ error: 'question 是必需的' }, 400);
  }

  const id = sessionId || crypto.randomUUID();
  log('new task', { sessionId: id, question, hasContext: !!context });

  return streamSSE(c, async (stream) => {
    try {
      const { stream: pipelineStream, result } = await runPipeline(question, id, {
        headless,
        context,
        model,
      });

      const reader = pipelineStream.getReader();
      const decoder = new TextDecoder();
      let currentEvent = 'chunk';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
            continue;
          }
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            try {
              const parsed = JSON.parse(data);
              // 透传事件名和完整 payload
              await stream.writeSSE({ event: currentEvent, data: JSON.stringify(parsed) });
            } catch {
              // ignore
            }
          }
        }
      }

      await result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('task error', msg);
      await stream.writeSSE({
        event: 'task.error',
        data: JSON.stringify({ message: msg }),
      });
    }
  });
});

console.log(`后端服务：http://localhost:${PORT}`);

Bun.serve({
  port: PORT,
  fetch: app.fetch,
  idleTimeout: 255,
});
