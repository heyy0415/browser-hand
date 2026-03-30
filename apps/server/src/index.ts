/** server — HTTP 服务入口 */
/// <reference types="bun-types" />

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { runPipeline } from '@browser-hand/engine';
import { logger } from '@browser-hand/engine';

const log = (msg: string, meta?: unknown) => logger.info('server', msg, meta);
const PORT = Number(process.env.PORT) || 3000;

const app = new Hono();

app.use('*', cors());

// 健康检查
app.get('/api/health', (c) => c.json({ status: 'ok' }));

// 主流程：POST /api/task
app.post('/api/task', async (c) => {
  const body = await c.req.json<{
    userInput: string;
    clientType?: 'web' | 'extension';
    pageHtml?: string;
    pageElements?: any[];
  }>();
  const { userInput, clientType = 'web', pageHtml, pageElements } = body;

  if (!userInput) {
    return c.json({ error: 'userInput 是必需的' }, 400);
  }

  const sessionId = crypto.randomUUID();
  log('new task', { sessionId, userInput, clientType });

  return streamSSE(c, async (stream) => {
    try {
      const { stream: pipelineStream, result } = await runPipeline(userInput, sessionId, {
        clientType,
        pageHtml,
        pageElements,
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

// Web 端 Playwright 执行端点：POST /api/execute-playwright
app.post('/api/execute-playwright', async (c) => {
  try {
    const body = await c.req.json<{
      code: string[];
    }>();
    const { code } = body;

    if (!Array.isArray(code) || code.length === 0) {
      return c.json({ error: '代码数组不能为空' }, 400);
    }

    // 使用 Bun 的 spawn 调用 Node.js 子进程执行 Playwright
    const results = [];
    
    for (let i = 0; i < code.length; i++) {
      const step = i + 1;
      try {
        const proc = Bun.spawn(['node', './packages/engine/playwright-runner.js', code[i]], {
          cwd: process.cwd(),
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const output = await new Response(proc.stdout).text();
        const result = JSON.parse(output);

        results.push({
          step,
          success: result.success,
          data: { code: code[i] },
          error: result.error,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          step,
          success: false,
          data: { code: code[i] },
          error: msg,
        });
      }
    }

    return c.json({ results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('playwright execution error', msg);
    return c.json({ error: msg }, 500);
  }
});

console.log(`后端服务：http://localhost:${PORT}`);

Bun.serve({
  port: PORT,
  fetch: app.fetch,
  idleTimeout: 255,
});
