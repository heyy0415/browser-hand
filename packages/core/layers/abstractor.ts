/** Layer 4: Abstractor — 将意图和精简 domText 抽象为可执行伪代码（v2.0 索引格式） */

import {
  ABSTRACTOR_SYSTEM_PROMPT,
  ABSTRACTOR_USER_PROMPT,
} from '../constants';
import { logger, streamLLM } from '../llm';
import type {
  DomText,
  ElementMap,
  FlowStep,
  AbstractorResult,
  AbstractorWarning,
  PseudoCodeLine,
} from '../types';

const log = (msg: string, meta?: unknown) => logger.info('abstractor', msg, meta);

export interface AbstractCallbacks {
  onDelta?: (delta: string) => void;
  onDeltaCompleted?: (content: string) => void;
  onError?: (error: string) => void;
  model?: string;
}

/** 多轮 Pipeline 时的额外选项 */
export interface AbstractOptions {
  /** 是否为多轮执行中的后续轮次 */
  isSubsequentRound?: boolean;
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

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

/**
 * 从 LLM 输出中提取伪代码行
 * v2.0 适配 [index] 格式：click([3]), fill([2], 'value')
 */
function extractPseudoCode(content: string): string[] {
  const endTag = '</thinking>';
  const endIndex = content.indexOf(endTag);
  const body = endIndex >= 0 ? content.slice(endIndex + endTag.length) : content;

  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-zA-Z][a-zA-Z0-9]*\(/.test(line));
}

/** 解析 domText 单行，提取 index / tag / zone / pos / text */
function parseDomTextLine(line: string): {
  index: number;
  tag: string;
  zone: string;
  pos: string;
  text: string;
  rawLine: string;
} | null {
  const match = line.match(/^\[(\d+)\]\s*<(\w+)([^>]*)>([\s\S]*?)<\/\w+>/);
  if (!match) return null;

  const index = parseInt(match[1], 10);
  const tag = match[2];
  const attrs = match[3];
  const text = match[4].trim();

  const zoneMatch = attrs.match(/data-zone="([^"]+)"/);
  const posMatch = attrs.match(/data-pos="([^"]+)"/);

  return {
    index,
    tag,
    zone: zoneMatch?.[1] || 'unknown',
    pos: posMatch?.[1] || 'mid-center',
    text,
    rawLine: line,
  };
}

/** 解析 filteredDomText 中所有可用元素 */
function parseFilteredDomText(filteredDomText: DomText) {
  return filteredDomText
    .split('\n')
    .map((line) => parseDomTextLine(line.trim()))
    .filter((e): e is NonNullable<typeof e> => e !== null);
}

/**
 * 构建伪代码行（v2.0 索引格式）
 * 从 LLM 输出或模板 fallback 生成的 code 行中提取 [index]
 */
function buildPseudoCodeLines(code: string[], flowSteps: FlowStep[]): PseudoCodeLine[] {
  // 伪代码方法名 → flow step action 类型的映射
  const methodToAction: Record<string, string> = {
    navigate: 'navigate', open: 'navigate',
    fill: 'fill', select: 'select',
    click: 'click', doubleClick: 'click',
    check: 'check', uncheck: 'uncheck',
    scrollDown: 'scroll', scrollUp: 'scroll', scrollToElement: 'scroll',
    wait: 'wait', waitForElementVisible: 'wait',
    getText: 'extract', extract: 'extract', extractWithRegex: 'extract', extractAll: 'extract',
    screenshot: 'screenshot',
  };

  // 按顺序将伪代码行映射到 flow step 索引
  const flowAssignment = new Map<number, number>(); // pseudocode index → flow step index
  let nextFlowIdx = 0;

  for (let pi = 0; pi < code.length; pi++) {
    const line = code[pi];
    const methodMatch = line.match(/^([a-zA-Z][a-zA-Z0-9]*)\(/);
    if (!methodMatch || flowSteps.length === 0) continue;

    const method = methodMatch[1];
    const action = methodToAction[method] || method;

    for (let fi = nextFlowIdx; fi < flowSteps.length; fi++) {
      if (flowSteps[fi].action === action) {
        flowAssignment.set(pi, fi);
        nextFlowIdx = fi + 1;
        break;
      }
    }
  }

  return code.map((codeLine, index) => {
    // 从伪代码中提取 [index] 索引
    const indexMatch = codeLine.match(/\[(\d+)\]/);
    const matchedElementIndex = indexMatch ? parseInt(indexMatch[1], 10) : null;

    const sourceStep = flowAssignment.get(index) ?? -1;
    const confidence = 1.0;

    return {
      lineNumber: index + 1,
      code: codeLine,
      sourceStep,
      matchedElementIndex,
      confidence,
    };
  });
}

/**
 * 模板 fallback：当 LLM 不可用或输出不足时，用简单匹配规则生成伪代码
 * v2.0 使用 elementMap 索引格式
 */
function fallbackAbstract(
  flowSteps: FlowStep[],
  filteredDomText: DomText,
  elementMap: ElementMap,
): AbstractorResult {
  const code: string[] = [];
  const availableElements = parseFilteredDomText(filteredDomText);

  for (let stepIndex = 0; stepIndex < flowSteps.length; stepIndex++) {
    const step = flowSteps[stepIndex];

    if (step.action === 'navigate') {
      code.push(`navigate('${step.target}')`);
      continue;
    }

    // 尝试通过 elementMap 匹配：zone → role → keyword
    let matchedIndex: number | null = null;

    // 按优先级匹配 elementMap 条目
    for (const entry of availableElements) {
      const mapEntry = elementMap[entry.index];
      if (!mapEntry) continue;

      let score = 0;

      // zone 匹配
      if (step.elementHint.zoneHint?.length && step.elementHint.zoneHint.includes(mapEntry.zone as never)) {
        score += 2;
      }

      // role 匹配
      if (step.elementHint.roleHint?.length && step.elementHint.roleHint.some(r => mapEntry.role.includes(r))) {
        score += 2;
      }

      // keyword 匹配
      if (step.elementHint.keywords?.length && step.elementHint.keywords.some(kw => mapEntry.rawText.includes(kw))) {
        score += 2;
      }

      // interactionHint 匹配
      if (step.elementHint.interactionHint) {
        const hint = step.elementHint.interactionHint;
        if (
          (hint === 'input' && (mapEntry.role.includes('input') || mapEntry.role.includes('searchbox') || mapEntry.role.includes('textarea'))) ||
          (hint === 'submit' && (mapEntry.role.includes('button'))) ||
          (hint === 'navigation' && (mapEntry.role.includes('link') || mapEntry.role.includes('button'))) ||
          (hint === 'selection' && (mapEntry.role.includes('select') || mapEntry.role.includes('combobox'))) ||
          (hint === 'toggle' && (mapEntry.role.includes('checkbox') || mapEntry.role.includes('radio')))
        ) {
          score += 1;
        }
      }

      // 需要至少 2 分才算匹配
      if (score >= 2) {
        matchedIndex = entry.index;
        break;
      }
    }

    if (matchedIndex !== null) {
      switch (step.action) {
        case 'click':
          code.push(`click([${matchedIndex}])`);
          break;
        case 'fill':
          code.push(`fill([${matchedIndex}], '${step.value || ''}')`);
          break;
        case 'select':
          code.push(`select([${matchedIndex}], '${step.value || ''}')`);
          break;
        case 'check':
          code.push(`check([${matchedIndex}])`);
          break;
        case 'uncheck':
          code.push(`uncheck([${matchedIndex}])`);
          break;
        case 'extract':
          code.push(`getText([${matchedIndex}])`);
          break;
        default:
          code.push(`click([${matchedIndex}])`);
      }
    } else if (step.action === 'scroll') {
      code.push('scrollDown()');
    } else if (step.action === 'wait') {
      code.push('wait(2000)');
    } else {
      code.push(`# WARNING: 未找到匹配元素 — flow.target="${step.target}"`);
      code.push('wait(2000)');
    }
  }

  const pseudoCode = buildPseudoCodeLines(code, flowSteps);
  const warnings = buildWarnings(code, flowSteps, elementMap);
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

/** 构建警告列表 */
function buildWarnings(
  code: string[],
  flowSteps: FlowStep[],
  _elementMap: ElementMap,
): AbstractorWarning[] {
  const warnings: AbstractorWarning[] = [];

  for (let stepIndex = 0; stepIndex < flowSteps.length; stepIndex++) {
    const step = flowSteps[stepIndex];
    if (step.action === 'navigate') continue;

    // 检查代码中是否存在该 step 对应的索引
    const methodToAction: Record<string, string> = {
      navigate: 'navigate', open: 'navigate',
      fill: 'fill', select: 'select',
      click: 'click', doubleClick: 'click',
      check: 'check', uncheck: 'uncheck',
      scrollDown: 'scroll', scrollUp: 'scroll',
      wait: 'wait', waitForElementVisible: 'wait',
      getText: 'extract', extract: 'extract', extractWithRegex: 'extract', extractAll: 'extract',
      screenshot: 'screenshot',
    };

    // 找到该 step 对应的伪代码行
    const hasMatchingCode = code.some((line) => {
      const methodMatch = line.match(/^([a-zA-Z][a-zA-Z0-9]*)\(/);
      if (!methodMatch) return false;
      const action = methodToAction[methodMatch[1]] || methodMatch[1];
      return action === step.action;
    });

    if (!hasMatchingCode) {
      warnings.push({
        type: 'no-match',
        stepIndex,
        message: `未找到匹配元素 — flow.target="${step.target}"`,
        suggestion: '等待页面加载后重新扫描',
      });
    }
  }

  return warnings;
}

// ═══════════════════════════════════════════════════════════════
// 主函数
// ═══════════════════════════════════════════════════════════════

/**
 * Abstractor 主入口（v2.0）
 * @param flowSteps Intention 层输出的操作步骤
 * @param filteredDomText Vector Gateway 过滤后的精简 domText
 * @param elementMap 完整元素映射表（用于 fallback 匹配）
 * @param pageUrl 当前页面 URL（用于跨页面检测）
 * @param callbacks 流式回调
 * @param options 额外选项
 */
export async function abstract(
  flowSteps: FlowStep[],
  filteredDomText: DomText,
  elementMap: ElementMap,
  pageUrl: string,
  callbacks: AbstractCallbacks = {},
  options: AbstractOptions = {},
): Promise<AbstractorResult> {
  const { isSubsequentRound } = options;

  try {
    let accumulated = '';
    let sentThinkingLength = 0;

    for await (const delta of streamLLM([
      { role: 'system', content: ABSTRACTOR_SYSTEM_PROMPT },
      {
        role: 'user',
        content: ABSTRACTOR_USER_PROMPT({
          flow: flowSteps,
          filteredDomText,
          pageUrl,
          isSubsequentRound,
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

    // 校验：非 navigate 步骤数应与 flowSteps 中非 navigate 步骤数一致
    const expectedNonNavSteps = flowSteps.filter((s) => s.action !== 'navigate').length;
    const actualNonNavSteps = code.filter((line) => {
      const m = line.match(/^([a-zA-Z][a-zA-Z0-9]*)\(/);
      return m && m[1] !== 'navigate' && m[1] !== 'open';
    }).length;

    // 校验：flow 中的 extract 步骤必须有对应的 getText/extract 伪代码
    const extractFlowSteps = flowSteps
      .map((s, i) => ({ action: s.action, index: i }))
      .filter((s) => s.action === 'extract');
    const hasGetTextInCode = code.some((line) => {
      const m = line.match(/^([a-zA-Z][a-zA-Z0-9]*)\(/);
      return m && (m[1] === 'getText' || m[1] === 'extract' || m[1] === 'extractWithRegex' || m[1] === 'extractAll');
    });

    let codeWithExtract = [...code];
    if (extractFlowSteps.length > 0 && !hasGetTextInCode) {
      // LLM 漏掉了 extract 步骤，手动补充
      // 尝试从 domText 中找一个 main-content 区域的元素索引
      const availableElements = parseFilteredDomText(filteredDomText);
      const mainContentEl = availableElements.find((e) => e.zone === 'main-content');
      const fallbackIdx = mainContentEl?.index ?? 0;
      for (const _flowStep of extractFlowSteps) {
        codeWithExtract.push(`getText([${fallbackIdx}])`);
      }
      log('supplemented missing extract steps', {
        extractSteps: extractFlowSteps.length,
        fallbackIndex: fallbackIdx,
      });
    }

    if (actualNonNavSteps < expectedNonNavSteps) {
      log('llm generated fewer steps than expected, supplementing with fallback', {
        expected: expectedNonNavSteps,
        actual: actualNonNavSteps,
      });

      // 用 fallback 补充缺失的步骤
      const fallbackResult = fallbackAbstract(flowSteps, filteredDomText, elementMap);
      const mergedCode = [...codeWithExtract];

      // 将 fallback 中 LLM 未覆盖的步骤追加到末尾
      for (const fbLine of fallbackResult.code) {
        const m = fbLine.match(/^([a-zA-Z][a-zA-Z0-9]*)\(/);
        const fbMethod = m ? m[1] : '';
        // 跳过 navigate/open（由 runner 或已有逻辑处理）
        if (fbMethod === 'navigate' || fbMethod === 'open') continue;
        // 如果 LLM 已生成该索引的操作，跳过
        const fbIndexMatch = fbLine.match(/\[(\d+)\]/);
        if (fbIndexMatch) {
          const fbIdx = fbIndexMatch[1];
          const alreadyCovered = mergedCode.some((existing) => existing.includes(`[${fbIdx}]`));
          if (alreadyCovered) continue;
        }
        mergedCode.push(fbLine);
      }

      const pseudoCode = buildPseudoCodeLines(mergedCode, flowSteps);
      const warnings = buildWarnings(mergedCode, flowSteps, elementMap);
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

    const pseudoCode = buildPseudoCodeLines(codeWithExtract, flowSteps);
    const warnings = buildWarnings(codeWithExtract, flowSteps, elementMap);
    const complexity = codeWithExtract.length <= 2 ? 'low' : codeWithExtract.length <= 5 ? 'medium' : 'high';

    log('done', { steps: codeWithExtract.length, method: 'llm' });

    return {
      pseudoCode,
      generationMethod: 'llm',
      warnings,
      code: codeWithExtract,
      summary: codeWithExtract.join(' -> '),
      thinking,
      meta: {
        totalSteps: codeWithExtract.length,
        estimatedComplexity: complexity,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    callbacks.onError?.(message);
    log('fallback', message);
    return fallbackAbstract(flowSteps, filteredDomText, elementMap);
  }
}
