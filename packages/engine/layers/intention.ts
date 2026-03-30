// layers/intention.ts

import { logger, createLLM } from '../utils';
import {
  INTENT_SYSTEM_PROMPT,
  INTENT_USER_PROMPT,
  LLM_MAX_RETRIES,
  LLM_RETRY_BASE_DELAY,
} from '../shared/index';
import type { IntentionResult } from '../types';

const log = (msg: string, meta?: unknown) => logger.info('intention', msg, meta);

/**
 * 回调接口 — 各层通过这个通知 pipeline 自己的进度
 */
export interface StepCallbacks {
  onDelta?: (accumulated: string) => void;
  ondeltaDone?: (content: string) => void;
  onError?: (error: string) => void;
}

/**
 * 流式调用 LLM，通过回调推送思考过程
 */
async function callWithStream(
  llm: ReturnType<typeof createLLM>,
  userInput: string,
  callbacks: StepCallbacks,
): Promise<IntentionResult> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < LLM_MAX_RETRIES; attempt++) {
    try {
      let accumulated = '';
      let deltaText = '';
      let inDelta = false;
      let deltaDone = false;

      const stream = await llm.stream([
        { role: 'system', content: INTENT_SYSTEM_PROMPT },
        { role: 'user', content: INTENT_USER_PROMPT(userInput) },
      ]);

      for await (const chunk of stream) {
        const token = typeof chunk.content === 'string' ? chunk.content : '';
        if (!token) continue;

        accumulated += token;

        // ── 状态机：解析 thinking / json 边界 ──
        if (!deltaDone) {
          if (!inDelta && accumulated.includes('<thinking>')) {
            inDelta = true;
            const idx = accumulated.indexOf('<thinking>') + '<thinking>'.length;
            deltaText = accumulated.slice(idx);
            continue;
          }

          if (inDelta && accumulated.includes('</thinking>')) {
            const thinkEnd = accumulated.indexOf('</thinking>');
            const thinkStart = accumulated.indexOf('<thinking>') + '<thinking>'.length;
            deltaText = accumulated.slice(thinkStart, thinkEnd);
            deltaDone = true;
            inDelta = false;
            callbacks.ondeltaDone?.(deltaText.trim());
            continue;
          }

          if (inDelta) {
            const thinkStart = accumulated.indexOf('<thinking>') + '<thinking>'.length;
            const currentThinking = accumulated.slice(thinkStart);
            if (currentThinking.length > deltaText.length) {
              const delta = currentThinking.slice(deltaText.length);
              deltaText = currentThinking;
              callbacks.onDelta?.(delta);
            }
            continue;
          }
        }
      }

      // ── 解析 JSON ──
      const thinkEnd = accumulated.indexOf('</thinking>');
      let json = thinkEnd >= 0
        ? accumulated.slice(thinkEnd + '</thinking>'.length).trim()
        : accumulated.trim();

      const m = json.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (m?.[1]) json = m[1].trim();

      const found = json.match(/\{[\s\S]*\}/);
      if (!found) {
        const fallback = accumulated.match(/\{[\s\S]*\}/);
        if (!fallback) throw new Error('LLM 响应中未找到 JSON');
        return JSON.parse(fallback[0]);
      }

      return JSON.parse(found[0]);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < LLM_MAX_RETRIES - 1) {
        const delay = LLM_RETRY_BASE_DELAY * Math.pow(2, attempt);
        callbacks.onError?.(`重试 #${attempt + 1}: ${lastError.message}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError ?? new Error('意图解析失败');
}

/**
 * 解析意图 — 不再自己创建 SSE 流，通过回调通知外部
 */
export async function parseIntention(
  userInput: string,
  callbacks: StepCallbacks = {},
): Promise<IntentionResult> {
  log('start', { userInput });

  const llm = createLLM(0, 'qwen-flash');
  const result = await callWithStream(llm, userInput, callbacks);

  log('done', result);
  return result;
}
