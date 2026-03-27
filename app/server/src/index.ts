/** server — HTTP 服务入口 */
/// <reference types="bun-types" />

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { runPipeline } from '../../../packages-engine/index';
import { logger } from '../../../packages-engine/index';

const log = (msg: string, meta?: unknown) => logger.info('server', msg, meta);
const PORT = Number(process.env.PORT) || 3000;

const app = new Hono();

app.use('*', cors());

// --- 健康检查 ---
app.get('/api/health', (c) => c.json({ status: 'ok' }));

// --- 主流程：POST /api/task（intention → scanner → vector → abstractor → runner）---
app.post('/api/task', async (c) => {
  const body = await c.req.json<{ userInput: string }>();
  const { userInput } = body;

  if (!userInput) {
    return c.json({ error: 'userInput 是必需的' }, 400);
  }

  const sessionId = crypto.randomUUID();
  log('new task', { sessionId, userInput });

  return streamSSE(c, async (stream) => {
    try {
      const { stream: pipelineStream, result } = await runPipeline(userInput, sessionId);

      // 将 pipeline 流式事件透传到 HTTP SSE
      const reader = pipelineStream.getReader();
      const decoder = new TextDecoder();
      let currentEvent = 'chunk';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        // 解析 SSE 消息并转发
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
        event: 'error',
        data: JSON.stringify({ message: msg }),
      });
    }
  });
});

// --- 简化版 SSE 透传 ---
app.post('/api/task/v2', async (c) => {
  const body = await c.req.json<{ userInput: string }>();
  const { userInput } = body;

  if (!userInput) {
    return c.json({ error: 'userInput 是必需的' }, 400);
  }

  const sessionId = crypto.randomUUID();
  log('new task', { sessionId, userInput });

  return streamSSE(c, async (stream) => {
    try {
      const { result } = await runPipeline(userInput, sessionId);

      // 监听 pipeline 内部事件（通过覆盖 send 函数实现）
      // 这里直接等结果完成后发送
      const pipelineResult = await result;

      await stream.writeSSE({
        event: 'step_complete',
        data: JSON.stringify({ step: 'intention', data: pipelineResult.intention }),
      });
      await stream.writeSSE({
        event: 'step_complete',
        data: JSON.stringify({ step: 'scanner', data: pipelineResult.scanner }),
      });
      await stream.writeSSE({
        event: 'step_complete',
        data: JSON.stringify({ step: 'vector', data: pipelineResult.vector }),
      });
      await stream.writeSSE({
        event: 'step_complete',
        data: JSON.stringify({ step: 'abstractor', data: pipelineResult.abstractor }),
      });
      await stream.writeSSE({
        event: 'step_complete',
        data: JSON.stringify({ step: 'runner', data: pipelineResult.runner }),
      });
      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({ success: true, sessionId }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('task error', msg);
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ message: msg }),
      });
      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({ success: false, sessionId }),
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
