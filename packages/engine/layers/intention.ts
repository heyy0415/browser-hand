import { INTENT_SYSTEM_PROMPT, INTENT_USER_PROMPT } from '@@browser-hand/engine-shared/constant';
import { logger, parseJSON, streamLLM } from '@@browser-hand/engine-shared/util';
import type { IntentionResult } from '@@browser-hand/engine-shared/type';

const log = (msg: string, meta?: unknown) => logger.info('intention', msg, meta);

export interface StepCallbacks {
  onDelta?: (delta: string) => void;
  onDeltaCompleted?: (content: string) => void;
  onError?: (error: string) => void;
  context?: Array<{ role: 'user' | 'assistant'; content: string }>;
  model?: string;
}

export async function parseIntention(
  question: string,
  callbacks: StepCallbacks = {},
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
        callbacks.onDelta?.(incrementalReasoning);
        emittedReasoningLength = reasoningContent.length;
      }
    }

    const finalReasoningContent = extractReasoningContent(accumulated).trim();
    callbacks.onDeltaCompleted?.(finalReasoningContent);

    const contentWithoutThinking = accumulated.replace(/<thinking>[\s\S]*?<\/thinking>/, '').trim();
    const jsonMatch = contentWithoutThinking.match(/\{[\s\S]*\}/) ?? accumulated.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('LLM 响应中未找到 JSON');
    }

    const result = parseJSON<IntentionResult>(jsonMatch[0]);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    callbacks.onError?.(message);
  }
}
