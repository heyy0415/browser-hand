/** Layer 1: Intention — 意图解析 */

import { INTENT_SYSTEM_PROMPT, INTENT_USER_PROMPT } from '../constants';
import { logger, parseJSON, streamLLM } from '../llm';
import type { IntentionResult } from '../types';

const log = (msg: string, meta?: unknown) => logger.info('intention', msg, meta);

export interface IntentionCallbacks {
  /** 思考过程流式回调 */
  onThinking?: (data: { delta: string; accumulated: string }) => void;
  /** 错误回调 */
  onError?: (error: string) => void;
  /** 对话上下文 */
  context?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** 模型名称 */
  model?: string;
}

export async function parseIntention(
  question: string,
  callbacks: IntentionCallbacks = {},
) {
  log('start', { question, hasContext: !!callbacks.context });

  try {
    // 构建消息列表：如果有上下文历史，将之前对话作为多轮消息
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: INTENT_SYSTEM_PROMPT },
    ];

    if (callbacks.context && callbacks.context.length > 0) {
      for (const msg of callbacks.context) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    messages.push({ role: 'user', content: INTENT_USER_PROMPT(question) });

    let accumulated = '';
    let emittedReasoningLength = 0;

    const extractReasoningContent = (text: string): string => {
      const thinkingStart = text.indexOf('<thinking>');
      if (thinkingStart === -1) {
        return '';
      }

      const contentStart = thinkingStart + '<thinking>'.length;
      const thinkingEnd = text.indexOf('</thinking>', contentStart);
      if (thinkingEnd === -1) {
        let content = text.slice(contentStart);
        // 处理 </thinking> 标签跨 delta 到达的情况：如果末尾包含不完整的标签前缀则截掉
        const lastOpenAngle = content.lastIndexOf('<');
        if (lastOpenAngle !== -1) {
          const tail = content.slice(lastOpenAngle);
          if ('</thinking>'.startsWith(tail)) {
            content = content.slice(0, lastOpenAngle);
          }
        }
        return content;
      }

      return text.slice(contentStart, thinkingEnd);
    };

    for await (const delta of streamLLM(messages, { model: callbacks.model })) {
      accumulated += delta;

      const reasoningContent = extractReasoningContent(accumulated);
      if (reasoningContent.length > emittedReasoningLength) {
        const incrementalReasoning = reasoningContent.slice(emittedReasoningLength);
        callbacks.onThinking?.({ delta: incrementalReasoning, accumulated: reasoningContent });
        emittedReasoningLength = reasoningContent.length;
      }
    }

    const contentWithoutThinking = accumulated.replace(/<thinking>[\s\S]*?<\/thinking>/, '').trim();
    const jsonMatch = contentWithoutThinking.match(/\{[\s\S]*\}/) ?? accumulated.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('LLM 响应中未找到 JSON');
    }

    const result = parseJSON<IntentionResult>(jsonMatch[0]);

    // 兼容：确保 flow 中的步骤有 positionalHint 和必填 elementHint
    if (result.flow) {
      result.flow = result.flow.map((step) => ({
        ...step,
        elementHint: step.elementHint ?? {
          roleHint: [],
          interactionHint: 'action' as const,
          zoneHint: [],
          keywords: [],
        },
        positionalHint: step.positionalHint ?? null,
        expectedOutcome: step.expectedOutcome ?? '',
      }));
    }

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    callbacks.onError?.(message);
  }
}
