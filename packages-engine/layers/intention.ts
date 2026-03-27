/** intention 层 — 意图解析，使用 LangChain + shared prompt */

import { createSSEStream, logger, createLLM, LLM_MAX_RETRIES, LLM_RETRY_BASE_DELAY } from '../utils';
import { INTENT_SYSTEM_PROMPT, INTENT_USER_PROMPT } from '../shared/index';
import type { IntentionResult } from '../types';

const log = (msg: string, meta?: unknown) => logger.info('intention', msg, meta);

async function callWithRetry(llm: ReturnType<typeof createLLM>, userInput: string): Promise<IntentionResult> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < LLM_MAX_RETRIES; attempt++) {
    try {
      const response = await llm.invoke([
        { role: 'system', content: INTENT_SYSTEM_PROMPT },
        { role: 'user', content: INTENT_USER_PROMPT(userInput) },
      ]);

      const raw = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);

      // 提取 JSON：去掉 markdown 代码块标记
      let json = raw.trim();
      const m = json.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (m?.[1]) json = m[1].trim();
      const found = json.match(/\{[\s\S]*\}/);
      if (!found) throw new Error('LLM 响应中未找到 JSON');

      const parsed = JSON.parse(found[0]) as IntentionResult;
      return parsed;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < LLM_MAX_RETRIES - 1) {
        const delay = LLM_RETRY_BASE_DELAY * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError ?? new Error('意图解析失败');
}

/** 解析用户输入为结构化意图 */
export async function parseIntention(userInput: string): Promise<{ stream: ReadableStream<Uint8Array>; result: Promise<IntentionResult> }> {
  const { stream, send, close } = createSSEStream();
  send('start', { message: '正在解析意图...' });
  log('start', { userInput });

  const llm = createLLM(0);

  const result = callWithRetry(llm, userInput)
    .then((intent) => {
      log('done', intent);
      send('chunk', intent);
      send('done', { success: true });
      close();
      return intent;
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
