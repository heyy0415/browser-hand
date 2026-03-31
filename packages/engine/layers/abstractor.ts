import {
  ABSTRACTOR_SYSTEM_PROMPT,
  ABSTRACTOR_USER_PROMPT,
} from '@@browser-hand/engine-shared/constant';
import { logger, streamLLM } from '@@browser-hand/engine-shared/util';
import type {
  VectorResult,
  AbstractorResult,
  IntentionResult,
  ElementSnapshot,
} from '@@browser-hand/engine-shared/type';

const log = (msg: string, meta?: unknown) => logger.info('abstractor', msg, meta);

export interface AbstractCallbacks {
  onDelta?: (delta: string) => void;
  ondeltaDone?: (thinking: string) => void;
  onError?: (error: string) => void;
}

function pickElement(target: string, elements: ElementSnapshot[]): ElementSnapshot | null {
  if (!target) {
    return elements[0] ?? null;
  }

  const lowerTarget = target.toLowerCase();
  for (const element of elements) {
    const hitText = `${element.label} ${element.selector} ${element.tag} ${element.role}`.toLowerCase();
    if (hitText.includes(lowerTarget)) {
      return element;
    }
  }

  return elements[0] ?? null;
}

function extractQuotedValue(desc: string): string {
  const m = desc.match(/["“”'‘’]([^"“”'‘’]+)["“”'‘’]/);
  if (m?.[1]) {
    return m[1];
  }
  return '';
}

function toPseudoCode(
  action: string,
  target: string,
  desc: string,
  picked: ElementSnapshot | null,
): string {
  const selector = picked?.selector || target;

  switch (action) {
    case 'navigate':
    case 'open':
    case 'goto':
    case 'visit':
      return `open('${target}')`;
    case 'click':
    case 'submit':
    case 'login':
    case 'logout':
    case 'sort':
    case 'filter':
      return `click('${selector}')`;
    case 'doubleclick':
      return `doubleClick('${selector}')`;
    case 'fill':
    case 'type':
    case 'search': {
      const value = extractQuotedValue(desc) || target;
      return `fill('${selector}', '${value}')`;
    }
    case 'select': {
      const value = extractQuotedValue(desc) || target;
      return `select('${selector}', '${value}')`;
    }
    case 'check':
      return `check('${selector}')`;
    case 'uncheck':
      return `uncheck('${selector}')`;
    case 'scroll':
      return `scrollDown()`;
    case 'extract':
      return `getText('${selector}')`;
    default:
      return `click('${selector}')`;
  }
}

function extractThinking(content: string): string {
  const start = content.indexOf('<thinking>');
  if (start < 0) {
    return '';
  }

  const afterStart = content.slice(start + '<thinking>'.length);
  const end = afterStart.indexOf('</thinking>');
  if (end < 0) {
    return afterStart;
  }

  return afterStart.slice(0, end);
}

function extractPseudoCode(content: string): string[] {
  const endTag = '</thinking>';
  const endIndex = content.indexOf(endTag);
  const body = endIndex >= 0 ? content.slice(endIndex + endTag.length) : content;

  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-zA-Z][a-zA-Z0-9]*\(/.test(line));
}

function fallbackAbstract(intention: IntentionResult, vector: VectorResult): AbstractorResult {
  const code: string[] = [];

  for (const step of intention.flow) {
    const picked = pickElement(step.target, vector.elements);
    code.push(toPseudoCode(step.action, step.target, step.desc, picked));
  }

  const complexity = code.length <= 2 ? 'low' : code.length <= 5 ? 'medium' : 'high';

  return {
    code,
    summary: code.join(' -> '),
    meta: {
      totalSteps: code.length,
      estimatedComplexity: complexity,
    },
  };
}

export async function abstract(
  intention: IntentionResult,
  vector: VectorResult,
  callbacks: AbstractCallbacks = {},
): Promise<AbstractorResult> {
  try {
    let accumulated = '';
    let sentThinkingLength = 0;

    for await (const delta of streamLLM([
      { role: 'system', content: ABSTRACTOR_SYSTEM_PROMPT },
      {
        role: 'user',
        content: ABSTRACTOR_USER_PROMPT({
          flow: intention,
          snapshot: {
            url: vector.url,
            pageType: 'unknown',
            elements: vector.elements,
          },
        }),
      },
    ])) {
      accumulated += delta;

      const currentThinking = extractThinking(accumulated);
      if (currentThinking.length > sentThinkingLength) {
        const thinkingDelta = currentThinking.slice(sentThinkingLength);
        sentThinkingLength = currentThinking.length;
        callbacks.onDelta?.(thinkingDelta);
      }
    }

    const thinking = extractThinking(accumulated).trim();
    callbacks.ondeltaDone?.(thinking);

    const code = extractPseudoCode(accumulated);
    if (code.length === 0) {
      throw new Error('LLM 响应中未找到可执行伪代码');
    }

    const complexity = code.length <= 2 ? 'low' : code.length <= 5 ? 'medium' : 'high';

    const result: AbstractorResult = {
      code,
      summary: code.join(' -> '),
      thinking,
      meta: {
        totalSteps: code.length,
        estimatedComplexity: complexity,
      },
    };

    log('done', { steps: code.length });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    callbacks.onError?.(message);
    log('fallback', message);
    return fallbackAbstract(intention, vector);
  }
}
