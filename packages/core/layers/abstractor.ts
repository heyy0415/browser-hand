/** Layer 4: Abstractor — 将意图和筛选后的元素抽象为可执行伪代码 */

import {
  ABSTRACTOR_SYSTEM_PROMPT,
  ABSTRACTOR_USER_PROMPT,
} from '../constants';
import { logger, streamLLM } from '../llm';
import type { VectorResult, AbstractorResult, IntentionResult, PseudoCodeLine, AbstractorWarning } from '../types';

const log = (msg: string, meta?: unknown) => logger.info('abstractor', msg, meta);

export interface AbstractCallbacks {
  onDelta?: (delta: string) => void;
  onDeltaCompleted?: (content: string) => void;
  onError?: (error: string) => void;
  model?: string;
}

function extractThinking(content: string): string {
  const start = content.indexOf('<thinking>');
  if (start < 0) return '';

  const afterStart = content.slice(start + '<thinking>'.length);
  const end = afterStart.indexOf('</thinking>');
  if (end < 0) {
    let text = afterStart;
    const lastOpenAngle = text.lastIndexOf('<');
    if (lastOpenAngle !== -1 && '</thinking>'.startsWith(text.slice(lastOpenAngle))) {
      text = text.slice(0, lastOpenAngle);
    }
    return text;
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

function buildPseudoCodeLines(code: string[], intention: IntentionResult, vector: VectorResult): PseudoCodeLine[] {
  return code.map((codeLine, index) => {
    // 尝试从伪代码中提取 selector
    const selectorMatch = codeLine.match(/'([^']+)'/);
    const selector = selectorMatch ? selectorMatch[1] : null;

    // 查找对应的 flow step
    let sourceStep = index;
    let matchedElement: string | null = selector;
    let confidence = 1.0;

    if (intention.flow) {
      // 匹配到 flow step
      const flowSteps = intention.flow.filter((s) => s.action !== 'navigate');
      if (index < flowSteps.length) {
        sourceStep = intention.flow.indexOf(flowSteps[index]);

        // 查找向量匹配结果
        const match = vector.matches.find((m) => m.matchedStep === sourceStep);
        if (match) {
          matchedElement = match.element.selector;
          confidence = match.score;
        }
      }
    }

    return {
      lineNumber: index + 1,
      code: codeLine,
      sourceStep,
      matchedElement,
      confidence,
    };
  });
}

/** 构建 Top3 匹配结果传给 ABSTRACTOR_USER_PROMPT */
function buildTopMatches(
  intention: IntentionResult,
  vector: VectorResult,
): Array<{
  stepIndex: number;
  target: string;
  matches: Array<{
    rank: number;
    selector: string;
    score: number;
    zone?: string;
    rect?: { x: number; y: number; width: number; height: number };
  }>;
}> {
  if (!intention.flow) return [];

  // 按 matchedStep 分组
  const stepMatches = new Map<number, Array<{ element: typeof vector.matches[number]['element']; score: number }>>();
  for (const m of vector.matches) {
    if (m.matchedStep === undefined) continue;
    if (!stepMatches.has(m.matchedStep)) stepMatches.set(m.matchedStep, []);
    stepMatches.get(m.matchedStep)!.push({ element: m.element, score: m.score });
  }

  const result: Array<{
    stepIndex: number;
    target: string;
    matches: Array<{
      rank: number;
      selector: string;
      score: number;
      zone?: string;
      rect?: { x: number; y: number; width: number; height: number };
    }>;
  }> = [];

  for (let i = 0; i < intention.flow.length; i++) {
    if (intention.flow[i].action === 'navigate') continue;
    const matches = stepMatches.get(i) || [];
    result.push({
      stepIndex: i,
      target: intention.flow[i].target,
      matches: matches.slice(0, 3).map((m, j) => ({
        rank: j + 1,
        selector: m.element.selector,
        score: m.score,
        zone: m.element.semantics?.zone,
        rect: m.element.rect,
      })),
    });
  }

  return result;
}

function buildWarnings(_code: string[], intention: IntentionResult, vector: VectorResult): AbstractorWarning[] {
  const warnings: AbstractorWarning[] = [];

  if (!intention.flow) return warnings;

  for (let stepIndex = 0; stepIndex < intention.flow.length; stepIndex++) {
    const step = intention.flow[stepIndex];
    if (step.action === 'navigate') continue;

    const match = vector.matches.find((m) => m.matchedStep === stepIndex);
    if (!match) {
      warnings.push({
        type: 'no-match',
        stepIndex,
        message: `未找到匹配元素 — flow.target="${step.target}"`,
        suggestion: '等待页面加载后重新扫描',
      });
    } else if (match.score < 0.5) {
      warnings.push({
        type: 'low-confidence',
        stepIndex,
        message: `${step.target} 匹配置信度较低 (${(match.score * 100).toFixed(1)}%)`,
        suggestion: '等待页面加载后重新扫描',
      });
    }
  }

  return warnings;
}

function fallbackAbstract(intention: IntentionResult, vector: VectorResult): AbstractorResult {
  const code: string[] = [];

  for (const step of intention.flow ?? []) {
    const stepIndex = intention.flow!.indexOf(step);
    const match = vector.matches.find((m) => m.matchedStep === stepIndex);

    if (step.action === 'navigate') {
      code.push(`open('${step.target}')`);
    } else if (match) {
      const selector = match.element.selector;
      switch (step.action) {
        case 'click':
          code.push(`click('${selector}')`);
          break;
        case 'fill':
          code.push(`fill('${selector}', '${step.value || ''}')`);
          break;
        case 'select':
          code.push(`select('${selector}', '${step.value || ''}')`);
          break;
        case 'check':
          code.push(`check('${selector}')`);
          break;
        case 'uncheck':
          code.push(`uncheck('${selector}')`);
          break;
        case 'extract':
          code.push(`getText('${selector}')`);
          break;
        case 'scroll':
          code.push('scrollDown()');
          break;
        default:
          code.push(`click('${selector}')`);
      }
    } else if (step.action === 'scroll') {
      code.push('scrollDown()');
    } else if (step.action === 'wait') {
      code.push('wait(2000)');
    } else {
      // 无匹配元素时，输出 WARNING + wait 而非静默跳过
      code.push(`# WARNING: 未找到匹配元素 — flow.target="${step.target}"`);
      code.push('wait(2000)');
    }
  }

  const pseudoCode = buildPseudoCodeLines(code, intention, vector);
  const warnings = buildWarnings(code, intention, vector);
  const complexity = code.length <= 2 ? 'low' : code.length <= 5 ? 'medium' : 'high';

  return {
    pseudoCode,
    generationMethod: 'template',
    warnings,
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
            title: vector.title,
            url: vector.url,
            elements: vector.elements,
            visibleText: vector.visibleText,
            capabilities: vector.capabilities,
            groupedElements: vector.groupedElements,
          },
          topMatches: buildTopMatches(intention, vector),
        }),
      },
    ], { model: callbacks.model })) {
      accumulated += delta;

      const currentThinking = extractThinking(accumulated);
      if (currentThinking.length > sentThinkingLength) {
        callbacks.onDelta?.(currentThinking.slice(sentThinkingLength));
        sentThinkingLength = currentThinking.length;
      }
    }

    const thinking = extractThinking(accumulated).trim();
    callbacks.onDeltaCompleted?.(thinking);

    const code = extractPseudoCode(accumulated);
    if (code.length === 0) {
      throw new Error('LLM 响应中未找到可执行伪代码');
    }

    // 校验：非 navigate 步骤数应与 intention.flow 中非 navigate 步骤数一致
    const expectedNonNavSteps = (intention.flow ?? []).filter((s) => s.action !== 'navigate').length;
    const actualNonNavSteps = code.filter((line) => {
      const m = line.match(/^([a-zA-Z][a-zA-Z0-9]*)\(/);
      return m && m[1] !== 'navigate' && m[1] !== 'open';
    }).length;

    if (actualNonNavSteps < expectedNonNavSteps) {
      log('llm generated fewer steps than expected, supplementing with fallback', {
        expected: expectedNonNavSteps,
        actual: actualNonNavSteps,
      });

      // 用 fallback 补充缺失的步骤
      const fallbackResult = fallbackAbstract(intention, vector);
      const mergedCode = [...code];

      // 将 fallback 中 LLM 未覆盖的步骤追加到末尾
      for (const fbLine of fallbackResult.code) {
        const m = fbLine.match(/^([a-zA-Z][a-zA-Z0-9]*)\(/);
        const fbMethod = m ? m[1] : '';
        // 跳过 navigate/open（由 runner 或已有逻辑处理）
        if (fbMethod === 'navigate' || fbMethod === 'open') continue;
        // 如果 LLM 已生成该 selector 的操作，跳过
        const fbSelector = fbLine.match(/'([^']+)'/)?.[1];
        if (fbSelector) {
          const alreadyCovered = mergedCode.some((existing) => existing.includes(`'${fbSelector}'`));
          if (alreadyCovered) continue;
        }
        mergedCode.push(fbLine);
      }

      const pseudoCode = buildPseudoCodeLines(mergedCode, intention, vector);
      const warnings = buildWarnings(mergedCode, intention, vector);
      const complexity = mergedCode.length <= 2 ? 'low' : mergedCode.length <= 5 ? 'medium' : 'high';

      log('done', { steps: mergedCode.length, method: 'llm+fallback' });

      return {
        pseudoCode,
        generationMethod: 'llm',
        warnings,
        code: mergedCode,
        summary: mergedCode.join(' -> '),
        thinking,
        meta: {
          totalSteps: mergedCode.length,
          estimatedComplexity: complexity,
        },
      };
    }

    const pseudoCode = buildPseudoCodeLines(code, intention, vector);
    const warnings = buildWarnings(code, intention, vector);
    const complexity = code.length <= 2 ? 'low' : code.length <= 5 ? 'medium' : 'high';

    log('done', { steps: code.length, method: 'llm' });

    return {
      pseudoCode,
      generationMethod: 'llm',
      warnings,
      code,
      summary: code.join(' -> '),
      thinking,
      meta: {
        totalSteps: code.length,
        estimatedComplexity: complexity,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    callbacks.onError?.(message);
    log('fallback', message);
    return fallbackAbstract(intention, vector);
  }
}
