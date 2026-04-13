/** Layer 3: Vector — 本地向量相似性检索（使用 transformer.js） */

import { pipeline, env } from '@xenova/transformers';
import { createSSEStream, logger } from '../llm';
import type {
  IntentionResult,
  ScannerResult,
  VectorOptions,
  VectorResult,
  ElementSnapshot,
  FunctionalZone,
  PageZone,
  IntentionStep,
  VectorMatch,
  PageCapabilities,
} from '../types';

const log = (msg: string, meta?: unknown) => logger.info('vector', msg, meta);

// ═══════════════════════════════════════════════════════════════════════
// Transformer.js 配置
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
// Embedding 缓存
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

// ═══════════════════════════════════════════════════════════════════════
// 向量计算
// ═══════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════
// 元素文本表示生成
// ═══════════════════════════════════════════════════════════════════════

function generateElementEmbeddingText(element: ElementSnapshot): string {
  const parts: string[] = [];

  if (element.semantics?.description) parts.push(element.semantics.description);
  if (element.label) parts.push(element.label);
  if (element.text) parts.push(element.text.substring(0, 100));
  parts.push(`${element.tag} ${element.role}`);
  if (element.semantics?.zone) parts.push(`位于${element.semantics.zone}区域`);
  if (element.semantics?.interactionHint) parts.push(`交互类型:${element.semantics.interactionHint}`);

  // 选择器语义
  const semanticPatterns = [
    { pattern: /search|搜索/gi, label: '搜索' },
    { pattern: /submit|提交/gi, label: '提交' },
    { pattern: /login|登录/gi, label: '登录' },
    { pattern: /btn|button/gi, label: '按钮' },
    { pattern: /input|输入/gi, label: '输入' },
    { pattern: /nav|导航/gi, label: '导航' },
    { pattern: /form|表单/gi, label: '表单' },
  ];

  for (const { pattern, label } of semanticPatterns) {
    if (pattern.test(element.selector) && !parts.includes(label)) {
      parts.push(label);
    }
  }

  return parts.join(' ');
}

function generateStepSearchQuery(step: IntentionStep): string {
  const parts: string[] = [step.target, step.desc];

  if (step.elementHint?.keywords) parts.push(...step.elementHint.keywords);
  if (step.elementHint?.interactionHint) parts.push(step.elementHint.interactionHint);

  const actionDescriptions: Record<string, string> = {
    fill: '输入框 文本框',
    click: '按钮 链接 可点击',
    select: '下拉选择 选项',
    check: '复选框 单选框',
    extract: '文本 内容',
  };
  if (actionDescriptions[step.action]) parts.push(actionDescriptions[step.action]);

  return parts.join(' ');
}

// ═══════════════════════════════════════════════════════════════════════
// 向量相似性检索
// ═══════════════════════════════════════════════════════════════════════

async function embedElements(elements: ElementSnapshot[]): Promise<void> {
  const texts = elements.map((el) => {
    el.embeddingText = generateElementEmbeddingText(el);
    return el.embeddingText;
  });

  const embeddings = await getEmbeddings(texts);
  for (let i = 0; i < elements.length; i++) {
    elements[i].embedding = embeddings[i];
  }
}

async function embedStep(step: IntentionStep): Promise<number[]> {
  step.searchQuery = generateStepSearchQuery(step);
  return getEmbedding(step.searchQuery);
}

function findElementsByEmbedding(
  queryVector: number[],
  elements: ElementSnapshot[],
  topK: number,
  minScore: number,
): Array<{ element: ElementSnapshot; score: number }> {
  const items = elements
    .filter((el) => el.embedding)
    .map((el) => ({ vector: el.embedding!, item: el }));

  return findTopKSimilar(queryVector, items, topK, minScore)
    .map((r) => ({ element: r.item, score: r.score }));
}

function findElementsByKeyword(
  step: IntentionStep,
  elements: ElementSnapshot[],
): Array<{ element: ElementSnapshot; score: number }> {
  const keywords: string[] = [
    ...(step.elementHint?.keywords || []),
    ...(step.target && step.target.length >= 2 ? [step.target] : []),
  ];

  return elements
    .map((element) => {
      let score = 0;
      const text = `${element.label} ${element.text} ${element.selector} ${element.semantics?.description || ''}`.toLowerCase();

      for (const keyword of keywords) {
        if (text.includes(keyword.toLowerCase())) score += 0.3;
      }

      if (step.elementHint?.interactionHint && element.semantics?.interactionHint === step.elementHint.interactionHint) {
        score += 0.2;
      }

      return { element, score: Math.min(score, 1) };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

function hybridSearch(
  step: IntentionStep,
  queryVector: number[],
  elements: ElementSnapshot[],
  topK: number,
  minScore: number,
): VectorMatch[] {
  const matches: Map<string, VectorMatch> = new Map();

  // 1. 向量检索 (权重 0.7)
  for (const { element, score } of findElementsByEmbedding(queryVector, elements, topK * 2, minScore)) {
    matches.set(element.uid, {
      element,
      score: score * 0.7,
      reason: `向量相似度: ${(score * 100).toFixed(1)}%`,
      matchType: 'embedding',
    });
  }

  // 2. 关键词检索 (权重 0.3)
  for (const { element, score } of findElementsByKeyword(step, elements)) {
    const existing = matches.get(element.uid);
    if (existing) {
      existing.score += score * 0.3;
    } else {
      matches.set(element.uid, {
        element,
        score: score * 0.3,
        reason: '关键词匹配',
        matchType: 'keyword',
      });
    }
  }

  // 3. elementHint 精准匹配加分
  if (step.elementHint) {
    for (const match of matches.values()) {
      let hintScore = 0;

      if (step.elementHint.interactionHint && match.element.semantics?.interactionHint === step.elementHint.interactionHint) {
        hintScore += 0.15;
      }
      if (step.elementHint.roleHint?.some((r) => match.element.role.includes(r))) {
        hintScore += 0.1;
      }
      if (step.elementHint.zoneHint?.some((z) => match.element.semantics?.zone?.includes(z))) {
        hintScore += 0.1;
      }

      if (hintScore > 0) {
        match.score += hintScore;
        match.matchType = 'hint';
        match.reason += ' + 特征匹配';
      }
    }
  }

  return Array.from(matches.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ═══════════════════════════════════════════════════════════════════════
// 页面能力分析
// ═══════════════════════════════════════════════════════════════════════

function analyzePageCapabilities(elements: ElementSnapshot[], title: string, url: string): PageCapabilities {
  const zones: Record<FunctionalZone, ElementSnapshot[]> = {
    'navigation': [], 'search': [], 'main-content': [], 'sidebar': [],
    'header': [], 'footer': [], 'modal': [], 'form': [],
    'list': [], 'card': [], 'unknown': [],
  };

  for (const el of elements) {
    zones[el.semantics?.zone || 'unknown'].push(el);
  }

  const zoneDescriptions: Record<FunctionalZone, string> = {
    'navigation': '导航区域', 'search': '搜索区域', 'main-content': '主要内容区域',
    'sidebar': '侧边栏', 'header': '页面头部', 'footer': '页面底部',
    'modal': '弹窗/对话框', 'form': '表单区域', 'list': '列表区域',
    'card': '卡片/商品区域', 'unknown': '其他区域',
  };

  const pageZones: PageZone[] = Object.entries(zones)
    .filter(([, els]) => els.length > 0)
    .map(([zone, els]) => ({
      zone: zone as FunctionalZone,
      elementCount: els.length,
      description: zoneDescriptions[zone as FunctionalZone],
      keyElements: els.slice(0, 3)
        .map((el) => el.semantics?.description || el.label || el.selector)
        .filter(Boolean),
    }));

  const hasSearch = elements.some((el) =>
    el.role === 'searchbox' ||
    (el.semantics?.interactionHint === 'input' && /search|搜索|keyword|query|kw/i.test(el.selector + ' ' + (el.label || ''))),
  );

  const hasLogin = elements.some((el) =>
    /login|登录|signin|sign-in/i.test((el.label || '') + ' ' + el.selector) ||
    (el.semantics?.interactionHint === 'submit' && /login|登录/.test((el.label || '') + ' ' + (el.text || ''))),
  );

  const hasForm = elements.some((el) =>
    el.semantics?.zone === 'form' || el.tag === 'form' || el.role === 'text-input',
  );

  const urlLower = url.toLowerCase();
  const titleLower = title.toLowerCase();

  let pageType: PageCapabilities['pageType'] = 'unknown';
  if (hasSearch && /google|baidu|bing|search/i.test(urlLower + titleLower)) pageType = 'search-engine';
  else if (/taobao|jd|amazon|shop|mall|buy|cart/i.test(urlLower + titleLower)) pageType = 'e-commerce';
  else if (/weibo|twitter|facebook|instagram|douyin|tiktok/i.test(urlLower + titleLower)) pageType = 'social-media';
  else if (zones['card'].length > 3 || zones['list'].length > 0) pageType = 'content';
  else if (hasForm || zones['form'].length > 2) pageType = 'form';
  else if (/dashboard|console|admin/i.test(urlLower + titleLower)) pageType = 'dashboard';

  const mainFunctions: string[] = [];
  if (hasSearch) mainFunctions.push('搜索功能');
  if (hasLogin) mainFunctions.push('登录功能');
  if (zones['navigation'].length > 0) mainFunctions.push('导航功能');
  if (zones['card'].length > 3) mainFunctions.push('内容浏览');
  if (zones['form'].length > 0) mainFunctions.push('表单填写');

  return {
    mainFunctions: mainFunctions.slice(0, 3),
    zones: pageZones,
    pageType,
    hasSearch,
    hasLogin,
    hasForm,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 导出接口
// ═══════════════════════════════════════════════════════════════════════

export async function isModelReady(): Promise<boolean> {
  return embeddingPipeline !== null;
}

export async function preloadModel(): Promise<void> {
  await getEmbeddingPipeline();
}

export function clearEmbeddingCache(): void {
  embeddingCache.clear();
}

/** 向量检索主函数 */
export async function vectorize(
  scan: ScannerResult,
  intention: IntentionResult,
  options: VectorOptions = {},
): Promise<VectorResult> {
  const topK = options.topK || 20;
  const minScore = options.minScore || 0.3;

  log('start', { elementCount: scan.elements.length, hasFlow: !!intention.flow });

  // 1. 为所有元素生成 embedding
  log('generating embeddings');
  await embedElements(scan.elements);

  // 2. 分析页面能力
  const capabilities = analyzePageCapabilities(scan.elements, scan.title || '', scan.url);

  // 3. 无 flow 时返回默认元素
  if (!intention.flow || intention.flow.length === 0) {
    return {
      url: scan.url,
      title: scan.title || '',
      matches: scan.elements.slice(0, topK).map((el) => ({
        element: el, score: 0.5, reason: '默认返回', matchType: 'keyword' as const,
      })),
      elements: scan.elements.slice(0, topK),
      visibleText: scan.visibleText || [],
      capabilities,
      success: true,
      message: '无操作流程，返回默认元素',
    };
  }

  // 4. 为每个步骤进行向量检索
  const allMatches: VectorMatch[] = [];
  const matchedElementIds = new Set<string>();

  for (let stepIndex = 0; stepIndex < intention.flow.length; stepIndex++) {
    const step = intention.flow[stepIndex];
    if (step.action === 'navigate') continue;

    log(`embedding step ${stepIndex}: ${step.action}`);
    const queryVector = await embedStep(step);
    const stepMatches = hybridSearch(step, queryVector, scan.elements, Math.ceil(topK / intention.flow.length), minScore);

    for (const match of stepMatches) {
      if (!matchedElementIds.has(match.element.uid)) {
        matchedElementIds.add(match.element.uid);
        match.matchedStep = stepIndex;
        allMatches.push(match);
      }
    }
  }

  // 5. 排序取 topK
  allMatches.sort((a, b) => b.score - a.score);
  const selectedElements = allMatches.slice(0, topK).map((m) => m.element);

  // 6. 按区域分组
  const groupedElements: Record<FunctionalZone, ElementSnapshot[]> = {
    'navigation': [], 'search': [], 'main-content': [], 'sidebar': [],
    'header': [], 'footer': [], 'modal': [], 'form': [],
    'list': [], 'card': [], 'unknown': [],
  };
  for (const el of selectedElements) {
    groupedElements[el.semantics?.zone || 'unknown'].push(el);
  }

  log('done', { matchedCount: selectedElements.length, topScore: allMatches[0]?.score?.toFixed(2) });

  return {
    url: scan.url,
    title: scan.title || '',
    matches: allMatches.slice(0, topK),
    elements: selectedElements,
    visibleText: scan.visibleText || [],
    capabilities,
    groupedElements,
    success: true,
    message: `向量检索完成，匹配 ${selectedElements.length} 个元素`,
  };
}

/** SSE 流式处理版本 */
export async function processVector(
  scan: ScannerResult,
  intention: IntentionResult,
  options: VectorOptions = {},
): Promise<{ stream: ReadableStream<Uint8Array>; result: Promise<VectorResult> }> {
  const { stream, send, close } = createSSEStream();

  const result = (async () => {
    send('conversation_start', { step: 'vector' });
    const vectorResult = await vectorize(scan, intention, options);
    send('conversation_completed', {
      step: 'vector',
      data: {
        elementCount: vectorResult.elements.length,
        capabilities: vectorResult.capabilities,
        topMatches: vectorResult.matches.slice(0, 5).map((m) => ({
          selector: m.element.selector,
          score: m.score.toFixed(2),
          reason: m.reason,
        })),
      },
    });
    send('conversation_done', { success: true });
    close();
    return vectorResult;
  })();

  return { stream, result };
}
