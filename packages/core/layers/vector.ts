/** Layer 3: Vector Gateway (v2.0) — 智能过滤网关
 * Plan A: 代码硬过滤（99% 场景，0 延迟）
 * Plan B: 语义降级（1% 模糊场景，transformers.js 向量检索）
 */

import { pipeline, env } from '@xenova/transformers';
import { logger } from '../llm';
import type { DomText, ElementMap, VectorGatewayResult, VectorGatewayRoute, FlowStep } from '../types';

const log = (msg: string, meta?: unknown) => logger.info('vector', msg, meta);

// ═══════════════════════════════════════════════════════════════════════
// Transformer.js 配置（Plan B 降级时使用）
// ═══════════════════════════════════════════════════════════════════════

env.cacheDir = './.model-cache';
const MODEL_NAME = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

let embeddingPipeline: Awaited<ReturnType<typeof pipeline>> | null = null;
let loadingPromise: Promise<void> | null = null;

async function getEmbeddingPipeline(): Promise<NonNullable<typeof embeddingPipeline>> {
  if (embeddingPipeline) return embeddingPipeline;
  if (loadingPromise) {
    await loadingPromise;
    if (embeddingPipeline) return embeddingPipeline;
  }
  loadingPromise = (async () => {
    log('loading model', { model: MODEL_NAME });
    embeddingPipeline = await pipeline('feature-extraction', MODEL_NAME, { quantized: true });
    log('model loaded');
  })();
  await loadingPromise;
  return embeddingPipeline!;
}

// ═══════════════════════════════════════════════════════════════════════
// Embedding 缓存与计算（保留底层工具）
// ═══════════════════════════════════════════════════════════════════════

const embeddingCache = new Map<string, number[]>();

function getCacheKey(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash = hash & hash;
  }
  return `${text.length}:${hash}`;
}

export async function getEmbedding(text: string): Promise<number[]> {
  const cacheKey = getCacheKey(text);
  if (embeddingCache.has(cacheKey)) return embeddingCache.get(cacheKey)!;
  const extractor = await getEmbeddingPipeline();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const output = await extractor(text, { pooling: 'mean', normalize: true } as any);
  const embedding = Array.from((output as { data: Float32Array }).data);
  embeddingCache.set(cacheKey, embedding);
  return embedding;
}

export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const results: number[][] = new Array(texts.length);
  const uncached: { index: number; text: string }[] = [];
  for (let i = 0; i < texts.length; i++) {
    const cacheKey = getCacheKey(texts[i]);
    if (embeddingCache.has(cacheKey)) {
      results[i] = embeddingCache.get(cacheKey)!;
    } else {
      uncached.push({ index: i, text: texts[i] });
    }
  }
  if (uncached.length > 0) {
    const extractor = await getEmbeddingPipeline();
    for (const { index, text } of uncached) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const output = await extractor(text, { pooling: 'mean', normalize: true } as any);
      const embedding = Array.from((output as { data: Float32Array }).data);
      results[index] = embedding;
      embeddingCache.set(getCacheKey(text), embedding);
    }
  }
  return results;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

export function findTopKSimilar<T>(
  queryVector: number[],
  items: Array<{ vector: number[]; item: T }>,
  k: number,
  minScore = 0.3,
): Array<{ item: T; score: number }> {
  return items
    .map(({ vector, item }) => ({ item, score: cosineSimilarity(queryVector, vector) }))
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export async function preloadModel(): Promise<void> {
  await getEmbeddingPipeline();
}

export async function isModelReady(): Promise<boolean> {
  return embeddingPipeline !== null;
}

export function clearEmbeddingCache(): void {
  embeddingCache.clear();
}

// ═══════════════════════════════════════════════════════════════════════
// v2.0 智能网关核心
// ═══════════════════════════════════════════════════════════════════════

export interface VectorCallbacks {
  /** 网关路由决策回调 */
  onGateway?: (data: { route: VectorGatewayRoute; originalLines: number; filteredLines: number; compressionRatio: string }) => void;
}

/**
 * 判断 flow 是否属于"极度模糊"指令
 * 当所有 step 的 elementHint 和 positionalHint 均为空/unknown 时返回 true
 */
export function isVagueFlow(flow: FlowStep[]): boolean {
  if (flow.length === 0) return true;
  return flow.every((step) => {
    const noKeywords = !step.elementHint?.keywords?.length;
    const noOrdinal = !step.positionalHint?.ordinal;
    const noDirection = !step.positionalHint?.direction;
    const zoneUnknown = !step.elementHint?.zoneHint?.length || step.elementHint.zoneHint.every((z) => z === 'unknown');
    return noKeywords && noOrdinal && noDirection && zoneUnknown;
  });
}

/**
 * 物理切割 domText 行：仅保留 hitIndices 中包含的行（及其邻居）
 */
function pruneDomText(domText: DomText, hitIndices: Set<number>): DomText {
  const lines = domText.split('\n');
  const result: string[] = [];

  for (const idx of hitIndices) {
    if (idx >= 0 && idx < lines.length) {
      result.push(lines[idx]);
    }
  }

  return result.join('\n');
}

/**
 * Plan A 硬过滤逻辑
 * 根据 FlowStep 的结构化特征对 elementMap 进行暴力裁剪
 */
function planAHardFilter(flow: FlowStep[], elementMap: ElementMap): Set<number> {
  const hitIndices = new Set<number>();
  const entries = Object.entries(elementMap);

  for (const step of flow) {
    // 跳过 navigate 步骤
    if (step.action === 'navigate') continue;

    let candidates = entries;

    // 1. 空间硬拦截（direction）
    if (step.positionalHint?.direction) {
      const dir = step.positionalHint.direction;
      candidates = candidates.filter(([, m]) => {
        if (dir === 'bottom') return m.yRatio > 0.6;
        if (dir === 'top') return m.yRatio < 0.4;
        if (dir === 'left') return m.rect.x < 0.33;
        if (dir === 'right') return m.rect.x > 0.66;
        // 复合方向
        if (dir.startsWith('bottom')) return m.yRatio > 0.5;
        if (dir.startsWith('top')) return m.yRatio < 0.5;
        return true;
      });
    }

    // 2. 序号拦截（ordinal）
    if (step.positionalHint?.ordinal) {
      const ordinal = step.positionalHint.ordinal;
      candidates = [...candidates].sort((a, b) => a[1].rect.y - b[1].rect.y);
      if (ordinal > 0) {
        candidates = candidates.slice(ordinal - 1, ordinal);
      } else if (ordinal === -1) {
        candidates = candidates.slice(-1);
      }
    }

    // 3. 区域拦截（zoneHint）
    if (step.elementHint?.zoneHint?.length) {
      const zones = step.elementHint.zoneHint.filter((z) => z !== 'unknown');
      if (zones.length > 0) {
        candidates = candidates.filter(([, m]) => zones.some((z) => m.zone === z));
      }
    }

    // 4. 角色拦截（roleHint / interactionHint）
    if (step.elementHint?.roleHint?.length) {
      const roles = step.elementHint.roleHint;
      candidates = candidates.filter(([, m]) => roles.some((r) => m.role.includes(r)));
    }
    if (step.elementHint?.interactionHint) {
      const hint = step.elementHint.interactionHint;
      candidates = candidates.filter(([, m]) => {
        if (m.role === hint) return true;
        // 兼容映射
        if (hint === 'submit' && m.role === 'button') return true;
        if (hint === 'action' && (m.role === 'button' || m.role === 'clickable')) return true;
        if (hint === 'input' && (m.role === 'text-input' || m.role === 'searchbox' || m.role === 'textarea')) return true;
        if (hint === 'selection' && (m.role === 'select' || m.role === 'checkbox' || m.role === 'radio')) return true;
        return false;
      });
    }

    // 5. 关键词兜底（rawText includes）
    const kws = step.elementHint?.keywords?.length
      ? step.elementHint.keywords
      : step.target ? [step.target] : [];
    if (kws.length > 0 && kws[0]) {
      const filteredByKw = candidates.filter(([, m]) =>
        kws.some((k) => m.rawText.toLowerCase().includes(k.toLowerCase()) || m.selector.toLowerCase().includes(k.toLowerCase())),
      );
      // 关键词过滤可能过度裁剪，只在有结果时替换
      if (filteredByKw.length > 0) {
        candidates = filteredByKw;
      }
    }

    // 6. 收集命中索引及上下文邻居（±1）
    for (const [idx] of candidates) {
      const index = Number(idx);
      hitIndices.add(index);
      if (index - 1 >= 0) hitIndices.add(index - 1);
      hitIndices.add(index + 1); // 越界由 pruneDomText 处理
    }
  }

  return hitIndices;
}

/**
 * Plan B 语义降级
 * 使用 transformers.js 对 elementMap.embeddingText 做向量 Top-K 召回
 */
async function planBSemanticFallback(
  flow: FlowStep[],
  domText: DomText,
  elementMap: ElementMap,
): Promise<{ filteredDomText: DomText; matches: Array<{ index: number; score: number; matchedStep: number }> }> {
  const entries = Object.entries(elementMap);
  if (entries.length === 0) {
    return { filteredDomText: domText, matches: [] };
  }

  // 为所有元素生成 embedding
  const texts = entries.map(([, m]) => m.embeddingText);
  let elementVectors: number[][];
  try {
    elementVectors = await getEmbeddings(texts);
  } catch (e) {
    log('Plan B embedding failed, returning full domText', e instanceof Error ? e.message : String(e));
    return { filteredDomText: domText, matches: [] };
  }

  const hitIndices = new Set<number>();
  const allMatches: Array<{ index: number; score: number; matchedStep: number }> = [];

  for (let stepIdx = 0; stepIdx < flow.length; stepIdx++) {
    const step = flow[stepIdx];
    if (step.action === 'navigate') continue;

    // 生成 step 查询文本
    const queryParts = [step.target, step.desc];
    if (step.elementHint?.keywords) queryParts.push(...step.elementHint.keywords);
    const queryText = queryParts.filter(Boolean).join(' ');

    let queryVector: number[];
    try {
      queryVector = await getEmbedding(queryText);
    } catch {
      continue;
    }

    // Top-K 召回
    const items = entries.map(([idx], i) => ({
      vector: elementVectors[i],
      item: Number(idx),
    }));

    const topK = findTopKSimilar(queryVector, items, 5, 0.3);
    for (const { item: idx, score } of topK) {
      hitIndices.add(idx);
      if (idx - 1 >= 0) hitIndices.add(idx - 1);
      hitIndices.add(idx + 1);
      allMatches.push({ index: idx, score, matchedStep: stepIdx });
    }
  }

  const filteredDomText = pruneDomText(domText, hitIndices);
  return { filteredDomText, matches: allMatches };
}

/**
 * Vector 智能网关主入口
 */
export async function vectorGateway(
  flow: FlowStep[],
  domText: DomText,
  elementMap: ElementMap,
  callbacks: VectorCallbacks = {},
): Promise<VectorGatewayResult> {
  const originalLines = domText.split('\n').filter((l) => l.trim()).length;

  // 判断是否走 Plan B
  const vague = isVagueFlow(flow);

  if (vague) {
    // === Plan B: 语义降级 ===
    log('Plan B: semantic fallback', { originalLines });
    const { filteredDomText, matches } = await planBSemanticFallback(flow, domText, elementMap);
    const filteredLines = filteredDomText.split('\n').filter((l) => l.trim()).length;
    const ratio = originalLines > 0 ? Math.round((1 - filteredLines / originalLines) * 100) : 0;

    const result: VectorGatewayResult = {
      filteredDomText,
      route: 'PLAN_B_SEMANTIC',
      originalLines,
      filteredLines,
      compressionRatio: `${ratio}%`,
      semanticMatches: matches,
    };

    callbacks.onGateway?.({
      route: 'PLAN_B_SEMANTIC',
      originalLines,
      filteredLines,
      compressionRatio: `${ratio}%`,
    });

    return result;
  }

  // === Plan A: 硬过滤 ===
  log('Plan A: hard filter', { originalLines });
  const hitIndices = planAHardFilter(flow, elementMap);

  // Plan A 结果为空时自动降级到 Plan B
  if (hitIndices.size === 0) {
    log('Plan A yielded 0 results, falling back to Plan B');
    const { filteredDomText, matches } = await planBSemanticFallback(flow, domText, elementMap);
    const filteredLines = filteredDomText.split('\n').filter((l) => l.trim()).length;
    const ratio = originalLines > 0 ? Math.round((1 - filteredLines / originalLines) * 100) : 0;

    const result: VectorGatewayResult = {
      filteredDomText,
      route: 'PLAN_B_SEMANTIC',
      originalLines,
      filteredLines,
      compressionRatio: `${ratio}%`,
      semanticMatches: matches,
    };

    callbacks.onGateway?.({
      route: 'PLAN_B_SEMANTIC',
      originalLines,
      filteredLines,
      compressionRatio: `${ratio}%`,
    });

    return result;
  }

  const filteredDomText = pruneDomText(domText, hitIndices);
  const filteredLines = filteredDomText.split('\n').filter((l) => l.trim()).length;
  const ratio = originalLines > 0 ? Math.round((1 - filteredLines / originalLines) * 100) : 0;

  const result: VectorGatewayResult = {
    filteredDomText,
    route: 'PLAN_A_HARDFILTER',
    originalLines,
    filteredLines,
    compressionRatio: `${ratio}%`,
  };

  callbacks.onGateway?.({
    route: 'PLAN_A_HARDFILTER',
    originalLines,
    filteredLines,
    compressionRatio: `${ratio}%`,
  });

  log('done', { route: 'PLAN_A_HARDFILTER', originalLines, filteredLines, compressionRatio: `${ratio}%` });

  return result;
}
