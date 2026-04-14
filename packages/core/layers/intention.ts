/** Layer 1: Intention — 意图解析（强校验与兜底） */

import { z } from 'zod';
import { INTENT_SYSTEM_PROMPT, INTENT_USER_PROMPT } from '../constants';
import { logger, parseJSON, streamLLM } from '../llm';
import type { IntentionResult, PageSummary } from '../types';

const log = (msg: string, meta?: unknown) => logger.info('intention', msg, meta);

// ═══════════════════════════════════════════════════════════════════════
// Zod Schema
// ═══════════════════════════════════════════════════════════════════════

const PositionalHintSchema = z.object({
  ordinal: z.number().optional(),
  direction: z.enum(['top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right']).optional(),
  scope: z.enum(['sibling', 'zone', 'viewport', 'nearby']),
  referenceTarget: z.string().optional(),
}).nullable();

const ElementHintSchema = z.object({
  roleHint: z.array(z.string()),
  interactionHint: z.enum(['input', 'submit', 'cancel', 'selection', 'navigation', 'toggle', 'action']),
  zoneHint: z.array(z.string()),
  keywords: z.array(z.string()),
});

const FlowStepSchema = z.object({
  action: z.enum(['navigate', 'fill', 'click', 'select', 'check', 'uncheck', 'scroll', 'wait', 'extract', 'screenshot']),
  target: z.string(),
  targetType: z.enum(['url', 'element-description', 'selector', 'position']),
  desc: z.string(),
  value: z.string().optional(),
  elementHint: ElementHintSchema,
  positionalHint: PositionalHintSchema,
  expectedOutcome: z.string(),
});

const IntentionResultSchema = z.object({
  status: z.enum(['success', 'clarification_needed', 'out_of_scope']),
  reply: z.string().nullable().optional(),
  flow: z.array(FlowStepSchema).nullable().optional(),
  question: z.array(z.string()).nullable().optional(),
});

// ═══════════════════════════════════════════════════════════════════════
// 正则兜底引擎
// ═══════════════════════════════════════════════════════════════════════

const DOMAIN_MAP: Record<string, string> = {
  '百度': 'https://www.baidu.com',
  '淘宝': 'https://www.taobao.com',
  '京东': 'https://www.jd.com',
  '谷歌': 'https://www.google.com',
  'github': 'https://github.com',
  '知乎': 'https://www.zhihu.com',
  '抖音': 'https://www.douyin.com',
  '微博': 'https://www.weibo.com',
  'b站': 'https://www.bilibili.com',
  '哔哩哔哩': 'https://www.bilibili.com',
};

function regexFallback(input: string): IntentionResult | null {
  // 识别 "打开/进入/访问/前往 + 站点名"
  const openMatch = input.match(/(?:打开|进入|访问|前往|去)\s*(.+)/);
  if (openMatch) {
    const target = openMatch[1].trim();
    const url = DOMAIN_MAP[target] || (/^https?:\/\//i.test(target) ? target : null);
    if (url) {
      return {
        status: 'success',
        reply: null,
        flow: [{
          action: 'navigate',
          target: url,
          targetType: 'url',
          desc: `打开${target}`,
          elementHint: { roleHint: [], interactionHint: 'action', zoneHint: [], keywords: [] },
          positionalHint: null,
          expectedOutcome: '页面加载完成',
        }],
        question: null,
      };
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// 回调接口
// ═══════════════════════════════════════════════════════════════════════

export interface IntentionCallbacks {
  onThinking?: (data: { delta: string; accumulated: string }) => void;
  onError?: (error: string) => void;
  context?: Array<{ role: 'user' | 'assistant'; content: string }>;
  model?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// 主解析函数
// ═══════════════════════════════════════════════════════════════════════

export async function parseIntention(
  question: string,
  callbacks: IntentionCallbacks = {},
  pageSummary?: PageSummary,
) {
  log('start', { question, hasContext: !!callbacks.context, hasPageSummary: !!pageSummary });

  try {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: INTENT_SYSTEM_PROMPT },
    ];

    if (callbacks.context && callbacks.context.length > 0) {
      for (const msg of callbacks.context) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    messages.push({ role: 'user', content: INTENT_USER_PROMPT(question, pageSummary) });

    // 尝试 LLM 解析（最多重试 1 次，共 2 次尝试）
    let result: IntentionResult | null = null;
    let lastError: string | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      let accumulated = '';
      let emittedReasoningLength = 0;

      const extractReasoningContent = (text: string): string => {
        const thinkingStart = text.indexOf('<thinking>');
        if (thinkingStart === -1) return '';
        const contentStart = thinkingStart + '<thinking>'.length;
        const thinkingEnd = text.indexOf('</thinking>', contentStart);
        if (thinkingEnd === -1) {
          let content = text.slice(contentStart);
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

      // 仅在首次尝试时流式回调
      if (attempt === 0) {
        for await (const delta of streamLLM(messages, { model: callbacks.model })) {
          accumulated += delta;
          const reasoningContent = extractReasoningContent(accumulated);
          if (reasoningContent.length > emittedReasoningLength) {
            const incrementalReasoning = reasoningContent.slice(emittedReasoningLength);
            callbacks.onThinking?.({ delta: incrementalReasoning, accumulated: reasoningContent });
            emittedReasoningLength = reasoningContent.length;
          }
        }
      } else {
        // 重试时不推送 thinking delta，直接收集
        for await (const delta of streamLLM(messages, { model: callbacks.model })) {
          accumulated += delta;
        }
      }

      const contentWithoutThinking = accumulated.replace(/<thinking>[\s\S]*?<\/thinking>/, '').trim();
      const jsonMatch = contentWithoutThinking.match(/\{[\s\S]*\}/) ?? accumulated.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        lastError = 'LLM 响应中未找到 JSON';
        continue;
      }

      try {
        const parsed = parseJSON<unknown>(jsonMatch[0]);
        const raw = IntentionResultSchema.parse(parsed);
        // 规范化：将 undefined 的可选字段补为 null，确保类型一致
        result = {
          status: raw.status,
          reply: raw.reply ?? null,
          flow: raw.flow ?? null,
          question: raw.question ?? null,
        } as IntentionResult;
        break; // 校验成功，跳出重试循环
      } catch (validationError) {
        lastError = validationError instanceof Error ? validationError.message : String(validationError);
        log(`attempt ${attempt + 1} validation failed`, { error: lastError });
        // 如果是第二次尝试也失败了，继续往下走兜底
        if (attempt === 0) {
          // 将校验错误信息附加到消息中重试
          messages.push({ role: 'assistant', content: accumulated });
          messages.push({
            role: 'user',
            content: `上一次输出的 JSON 格式有误：${lastError}\n请修正并重新输出完整的 JSON。`,
          });
        }
      }
    }

    // LLM 彻底失败，尝试正则兜底
    if (!result) {
      log('llm failed, trying regex fallback', { lastError });
      result = regexFallback(question);
      if (!result) {
        // 正则也失败，返回 out_of_scope
        result = {
          status: 'out_of_scope',
          reply: '意图解析失败，请重新描述您的需求。',
          flow: null,
          question: null,
        };
      }
      callbacks.onError?.(lastError || '意图解析失败，已使用兜底策略');
    }

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

    // 最终兜底
    const fallback = regexFallback(question);
    return fallback || { status: 'out_of_scope', reply: '意图解析失败', flow: null, question: null };
  }
}
