import { INTENT_SYSTEM_PROMPT, INTENT_USER_PROMPT } from '@@browser-hand/engine-shared/constant';
import { logger, parseJSON, streamLLM } from '@@browser-hand/engine-shared/util';
import type { IntentionResult } from '@@browser-hand/engine-shared/type';

const log = (msg: string, meta?: unknown) => logger.info('intention', msg, meta);

export interface StepCallbacks {
  onDelta?: (accumulated: string) => void;
  ondeltaDone?: (content: string) => void;
  onError?: (error: string) => void;
}

function fallbackIntention(question: string): IntentionResult {
  const text = question.trim();
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);

  if (urlMatch?.[0]) {
    return {
      flow: [
        {
          action: 'navigate',
          target: urlMatch[0],
          desc: `打开 ${urlMatch[0]}`,
        },
      ],
    };
  }

  if (text.includes('百度')) {
    return {
      flow: [
        { action: 'navigate', target: 'https://www.baidu.com', desc: '打开百度首页' },
      ],
    };
  }

  if (text.includes('github') || text.includes('GitHub')) {
    return {
      flow: [
        { action: 'navigate', target: 'https://github.com', desc: '打开 GitHub' },
      ],
    };
  }

  return {
    flow: [
      { action: 'navigate', target: 'https://www.baidu.com', desc: '默认打开百度首页' },
    ],
  };
}

export async function parseIntention(
  question: string,
  callbacks: StepCallbacks = {},
): Promise<IntentionResult> {
  log('start', { question });

  try {
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
        return text.slice(contentStart);
      }

      return text.slice(contentStart, thinkingEnd);
    };

    for await (const delta of streamLLM([
      { role: 'system', content: INTENT_SYSTEM_PROMPT },
      { role: 'user', content: INTENT_USER_PROMPT(question) },
    ])) {
      accumulated += delta;

      const reasoningContent = extractReasoningContent(accumulated);
      if (reasoningContent.length > emittedReasoningLength) {
        const incrementalReasoning = reasoningContent.slice(emittedReasoningLength);
        callbacks.onDelta?.(incrementalReasoning);
        emittedReasoningLength = reasoningContent.length;
      }
    }

    const finalReasoningContent = extractReasoningContent(accumulated).trim();
    callbacks.ondeltaDone?.(finalReasoningContent);

    const contentWithoutThinking = accumulated.replace(/<thinking>[\s\S]*?<\/thinking>/, '').trim();
    const jsonMatch = contentWithoutThinking.match(/\{[\s\S]*\}/) ?? accumulated.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('LLM 响应中未找到 JSON');
    }

    const result = parseJSON<IntentionResult>(jsonMatch[0]);
    log('done', { steps: result.flow.length });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    callbacks.onError?.(message);
    log('fallback', message);
    return fallbackIntention(question);
  }
}
