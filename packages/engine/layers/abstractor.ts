/** abstractor 层 — 操作规划，使用 LangChain + shared prompt */

import { createSSEStream, logger, createLLM } from '../utils';
import { PLAN_SYSTEM_PROMPT, PLAN_USER_PROMPT, LLM_MAX_RETRIES, LLM_RETRY_BASE_DELAY } from '../shared/index';
import type { IntentionResult, ScannerResult, AbstractorResult } from '../types';

const log = (msg: string, meta?: unknown) => logger.info('abstractor', msg, meta);

async function callWithRetry(
  llm: ReturnType<typeof createLLM>,
  intent: IntentionResult,
  snapshot: ScannerResult,
): Promise<AbstractorResult> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < LLM_MAX_RETRIES; attempt++) {
    try {
      // 严格按 prompt 中格式构建快照 JSON
      const snapshotJson = JSON.stringify({
        url: snapshot.url,
        elements: snapshot.elements.map((el) => ({
          uid: el.uid,
          tag: el.tag,
          role: el.role,
          label: el.label,
          selector: el.selector,
          framePath: el.framePath,
        })),
      });

      const response = await llm.invoke([
        { role: 'system', content: PLAN_SYSTEM_PROMPT },
        { role: 'user', content: PLAN_USER_PROMPT(JSON.stringify(intent), snapshotJson) },
      ]);

      const raw = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);

      // 提取伪代码：按 prompt 要求，直接输出伪代码，不在代码块中
      const lines = raw
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .filter((l) => !l.startsWith('```'))
        .filter((l) => !l.startsWith('//'))
        .filter((l) => !l.startsWith('#'));

      if (lines.length === 0) {
        throw new Error('LLM 未返回有效的伪代码');
      }

      return { code: lines, summary: `生成了 ${lines.length} 个操作步骤` };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < LLM_MAX_RETRIES - 1) {
        const delay = LLM_RETRY_BASE_DELAY * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError ?? new Error('动作计划生成失败');
}

/** 从意图 + 页面快照生成伪代码操作计划 */
export async function generateAbstractor(
  intent: IntentionResult,
  snapshot: ScannerResult,
): Promise<{ stream: ReadableStream<Uint8Array>; result: Promise<AbstractorResult> }> {
  const { stream, send, close } = createSSEStream();
  send('start', { message: '正在生成动作计划...' });
  log('start', { intent, snapshot });

  const llm = createLLM(0, 'qwen-flash');

  const result = callWithRetry(llm, intent, snapshot)
    .then((plan) => {
      log('done', plan);
      for (const line of plan.code) {
        send('action', { code: line });
      }
      send('done', { success: true, summary: plan.summary });
      close();
      return plan;
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', msg);
      send('error', { message: msg });
      send('done', { success: false });
      close();
      throw err;
    });

  return { stream, result };
}
