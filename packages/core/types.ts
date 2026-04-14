/** @browser-hand/core — 类型定义 */

// ═══════════════════════════════════════════════════════════════════════
// 枚举与基础类型
// ═══════════════════════════════════════════════════════════════════════

/** 操作类型分类 */
export type StepCategory =
  | 'interaction'   // 交互型：需要打开浏览器执行操作（click, fill, select 等）
  | 'extraction'    // 获取型：获取页面内容并返回（getText, extract）
  | 'navigation'    // 导航型：页面跳转（navigate）
  | 'observation';  // 观察型：不改变页面状态（screenshot, wait, scroll）

/** 标准化的操作动作类型 */
export type ActionType =
  | 'navigate'    // 打开/跳转页面
  | 'fill'        // 填写表单
  | 'click'       // 点击元素
  | 'select'      // 下拉选择
  | 'check'       // 勾选
  | 'uncheck'     // 取消勾选
  | 'scroll'      // 滚动页面
  | 'wait'        // 等待
  | 'extract'     // 提取数据
  | 'screenshot'; // 截图

/** 根据 ActionType 推断操作类型分类 */
export function getStepCategory(action: ActionType): StepCategory {
  switch (action) {
    case 'navigate':
      return 'navigation';
    case 'extract':
      return 'extraction';
    case 'screenshot':
    case 'wait':
    case 'scroll':
      return 'observation';
    default:
      return 'interaction';
  }
}

/** 目标类型区分 */
export type TargetType = 'url' | 'element-description' | 'selector' | 'position';

/** 交互类型提示 */
export type InteractionType =
  | 'input'          // 文本输入
  | 'submit'         // 提交/按钮
  | 'navigation'     // 链接/可点击列表项
  | 'selection'      // 下拉/复选/单选
  | 'toggle'         // 开关
  | 'action';        // 通用可操作

/** 功能区域类型 */
export type ZoneType =
  | 'search'
  | 'navigation'
  | 'header'
  | 'main-content'
  | 'sidebar'
  | 'form'
  | 'footer'
  | 'trending'
  | 'modal'
  | 'unknown';

// ═══════════════════════════════════════════════════════════════════════
// Intention 层类型定义
// ═══════════════════════════════════════════════════════════════════════

/** 元素特征提示，帮助 Vector 层筛选 */
export interface ElementHint {
  /** 期望的角色类型 */
  roleHint: string[];
  /** 期望的交互类型 */
  interactionHint: InteractionType;
  /** 期望的功能区域 */
  zoneHint: ZoneType[];
  /** 关键词匹配 */
  keywords: string[];
}

/** 位置概念提示 */
export interface PositionalHint {
  /** 序号提示："第一条" → 1, "最后" → -1 */
  ordinal?: number;
  /** 方向提示 */
  direction?: 'top' | 'bottom' | 'left' | 'right'
    | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** 搜索范围 */
  scope: 'sibling' | 'zone' | 'viewport' | 'nearby';
  /** scope=nearby 时的参考元素 */
  referenceTarget?: string;
}

/** 操作步骤结构（对齐 README FlowStep） */
export interface FlowStep {
  /** 标准化的动作类型 */
  action: ActionType;
  /** 目标标识 */
  target: string;
  /** 目标类型 */
  targetType: TargetType;
  /** 操作描述 */
  desc: string;
  /** 输入值（用于 fill/select 等操作） */
  value?: string;
  /** 元素特征提示（必填） */
  elementHint: ElementHint;
  /** 位置概念提示 */
  positionalHint: PositionalHint | null;
  /** 预期结果描述 */
  expectedOutcome: string;
  /** 用于向量检索的查询文本（运行时生成） */
  searchQuery?: string;
}

/** 旧版 IntentionStep（兼容保留） */
export interface IntentionStep {
  action: ActionType;
  category: StepCategory;
  target: string;
  targetType: TargetType;
  desc: string;
  value?: string;
  elementHint?: ElementHint;
  expectedOutcome?: string;
  searchQuery?: string;
}

export type IntentionStatus = 'success' | 'clarification_needed' | 'out_of_scope';

export interface IntentionResult {
  status: IntentionStatus;
  reply: string | null;
  flow: FlowStep[] | null;
  question: string[] | null;
}

// ═══════════════════════════════════════════════════════════════════════
// Scanner 层类型定义
// ═══════════════════════════════════════════════════════════════════════

export type SemanticRole =
  | 'link'
  | 'button'
  | 'text-input'
  | 'checkbox'
  | 'radio'
  | 'file-upload'
  | 'date-picker'
  | 'range-slider'
  | 'color-picker'
  | 'textarea'
  | 'select'
  | 'content-editable'
  | 'clickable'
  | 'canvas'
  | 'searchbox'
  | 'video'
  | 'audio'
  | 'iframe'
  | 'details';

export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 元素的功能区域类型 */
export type FunctionalZone =
  | 'navigation'
  | 'search'
  | 'main-content'
  | 'sidebar'
  | 'header'
  | 'footer'
  | 'modal'
  | 'form'
  | 'list'
  | 'card'
  | 'trending'
  | 'unknown';

/** 元素的语义描述，用于让 LLM 理解元素功能 */
export interface ElementSemantics {
  description: string;
  zone: FunctionalZone;
  parentContext?: string;
  relatedLabel?: string;
  visualHints?: string[];
  interactionHint?: 'submit' | 'cancel' | 'navigation' | 'action' | 'input' | 'selection' | 'toggle';
}

export interface ElementSnapshot {
  uid: string;
  tag: string;
  role: SemanticRole;
  selector: string;
  label: string;
  state: Record<string, unknown>;
  framePath: string[];
  text: string;
  rect: ElementRect;
  semantics?: ElementSemantics;
  embeddingText?: string;
  embedding?: number[];
  depth?: number;
  parentUid?: string | null;
  childrenUids?: string[];
}

/** 页面可见文本节点 */
export interface VisibleTextNode {
  tag: string;
  text: string;
  rect?: ElementRect;
  zone?: FunctionalZone;
}

/** 页面功能区域摘要 */
export interface ZoneSummary {
  zone: ZoneType;
  selector: string;
  elementCount: number;
  description: string;
}

/** 页面摘要 */
export interface PageSummary {
  pageType: string;
  mainFunctions: string[];
  zones: ZoneSummary[];
  hasSearch: boolean;
  hasLoginForm: boolean;
  url?: string;
  title?: string;
  zonesBoundingBox?: Record<string, ElementRect>;
}

/** 页面快照（Scanner 输出） */
export interface PageSnapshot {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  timestamp: number;
  totalElements: number;
  elements: ElementSnapshot[];
  visibleText: VisibleTextNode[];
  pageSummary: PageSummary;
  zonesBoundingBox?: Record<string, ElementRect>;
}

/** 旧版 ScannerResult（兼容保留） */
export interface ScannerResult {
  url: string;
  title: string;
  elements: ElementSnapshot[];
  visibleText: VisibleTextNode[];
  viewport?: { width: number; height: number };
  timestamp?: number;
  totalElements?: number;
  pageSummary?: PageSummary;
}

export interface ScanOptions {
  pageId?: string;
  timeout?: number;
  autoScroll?: boolean;
  scanFrames?: boolean;
}

/** 页面功能区域描述（旧版兼容） */
export interface PageZone {
  zone: FunctionalZone;
  elementCount: number;
  description: string;
  keyElements: string[];
}

/** 页面能力概述 */
export interface PageCapabilities {
  mainFunctions: string[];
  zones: PageZone[];
  pageType: 'search-engine' | 'e-commerce' | 'social-media' | 'content' | 'form' | 'dashboard' | 'unknown';
  hasSearch: boolean;
  hasLogin: boolean;
  hasForm: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// Vector 层类型定义
// ═══════════════════════════════════════════════════════════════════════

/** 分数明细 */
export interface ScoreBreakdown {
  vectorScore: number;       // 向量相似度 [0, 1]，权重 0.5
  keywordScore: number;      // 关键词匹配 [0, 1]，权重 0.2
  positionalScore: number;   // 位置与层级匹配 [0, 1]，权重 0.3
  zoneBoost: number;         // 区域加成 [0, 0.15]
}

/** 排序后的匹配元素 */
export interface RankedElement {
  element: ElementSnapshot;
  score: number;
  breakdown: ScoreBreakdown;
  rank: number;
}

/** 检索指标 */
export interface SearchMetrics {
  filterBefore: number;
  filterAfter: number;
  vectorComputeMs: number;
  totalMs: number;
}

/** 过滤后的快照（传给 Abstractor） */
export interface FilteredSnapshot {
  url: string;
  stepIndex: number;
  target: string;
  topMatch: RankedElement | null;
  candidates: RankedElement[];
  excluded: number;
  allElements: ElementSnapshot[];
}

/** Vector 层输出 */
export interface VectorOutput {
  stepIndex: number;
  target: string;
  totalCandidates: number;
  afterHardFilter: number;
  results: RankedElement[];
  searchMetrics: SearchMetrics;
}

/** 旧版 VectorMatch（兼容保留） */
export interface VectorMatch {
  element: ElementSnapshot;
  score: number;
  reason: string;
  matchedStep?: number;
  matchType: 'embedding' | 'keyword' | 'hint' | 'positional';
}

/** 旧版 VectorResult（兼容保留） */
export interface VectorResult {
  url: string;
  title: string;
  matches: VectorMatch[];
  elements: ElementSnapshot[];
  visibleText: VisibleTextNode[];
  capabilities?: PageCapabilities;
  groupedElements?: Record<string, ElementSnapshot[]>;
  queryEmbedding?: number[];
  success: boolean;
  message: string;
}

export interface VectorOptions {
  topK?: number;
  minScore?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// Abstractor 层类型定义
// ═══════════════════════════════════════════════════════════════════════

/** 伪代码行 */
export interface PseudoCodeLine {
  lineNumber: number;
  code: string;
  sourceStep: number;
  matchedElement: string | null;
  confidence: number;
}

/** Abstractor 警告 */
export interface AbstractorWarning {
  type: 'no-match' | 'low-confidence' | 'ambiguous' | 'multiple-candidates';
  stepIndex: number;
  message: string;
  suggestion: string;
}

/** Abstractor 输出 */
export interface AbstractorResult {
  pseudoCode: PseudoCodeLine[];
  generationMethod: 'template' | 'llm';
  warnings: AbstractorWarning[];
  /** 旧字段兼容 */
  code: string[];
  summary: string;
  thinking?: string;
  meta?: {
    totalSteps: number;
    estimatedComplexity: 'low' | 'medium' | 'high';
    requiresAuth?: boolean;
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Runner 层类型定义
// ═══════════════════════════════════════════════════════════════════════

/** Runner 每步执行结果 */
export interface StepResult {
  lineNumber: number;
  code: string;
  status: 'success' | 'failed' | 'skipped' | 'warning';
  action: ActionType;
  selector: string | null;
  value: string | null;
  elapsedMs: number;
  screenshot: string | null;
  error: string | null;
}

/** 提取的文本结果 */
export interface TextResult {
  selector: string;
  text: string;
  lineNumber: number;
}

/** 提取内容 */
export interface ExtractedContent {
  type: 'text' | 'screenshot' | 'mixed';
  textResults: TextResult[];
  screenshotResults: string[];
}

/** Runner 错误详情 */
export interface RunnerError {
  type: 'element-not-found' | 'timeout' | 'navigation-failed' | 'execution-error';
  lineNumber: number;
  code: string;
  message: string;
  screenshot: string | null;
}

/** 旧版 ActionResultType（兼容保留） */
export type ActionResultType =
  | 'click'
  | 'fill'
  | 'select'
  | 'check'
  | 'navigate'
  | 'screenshot'
  | 'extract'
  | 'wait'
  | 'scroll';

/** 旧版 ActionResult（兼容保留） */
export interface ActionResult {
  step: number;
  success: boolean;
  data?: {
    type?: ActionResultType;
    code?: string;
    pseudoCode?: string;
    script?: string;
    category?: StepCategory;
    target?: {
      uid: string;
      selector: string;
      tag: string;
      role: SemanticRole;
    };
    extracted?: string | string[];
    [key: string]: unknown;
  };
  error?: string;
  screenshot?: string;
}

/** Runner 输出 */
export interface RunnerResult {
  success: boolean;
  steps: StepResult[];
  extractedContent: ExtractedContent | null;
  finalScreenshot: string | null;
  error: RunnerError | null;
  totalElapsedMs: number;
  /** 旧字段兼容 */
  results: ActionResult[];
  duration?: number;
  extractedContents?: Array<{ selector: string; content: string | string[] }>;
}

export interface RunnerOptions {
  headless?: boolean;
  stepDelay?: number;
  screenshotPerStep?: boolean;
  actionTimeout?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// SSE 事件类型定义
// ═══════════════════════════════════════════════════════════════════════

export const SSE_EVENT_TYPES = [
  // 全局
  'task.start',
  'task.done',
  'task.error',
  // Intention
  'intention.start',
  'intention.thinking',
  'intention.done',
  // Scanner
  'scanner.start',
  'scanner.scanning',
  'scanner.done',
  // Vector
  'vector.start',
  'vector.filtering',
  'vector.computing',
  'vector.done',
  // Abstractor
  'abstractor.start',
  'abstractor.done',
  // Runner
  'runner.start',
  'runner.step-start',
  'runner.step-done',
  'runner.step-error',
  'runner.extract',
  'runner.done',
] as const;

export type SSEEventType = (typeof SSE_EVENT_TYPES)[number];

export interface SSEEvent<T = unknown> {
  event: SSEEventType;
  data: T;
  timestamp: number;
  sessionId: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Pipeline 类型定义
// ═══════════════════════════════════════════════════════════════════════

export interface PipelineResult {
  intention: IntentionResult;
  scan: ScannerResult;
  vector: VectorResult;
  abstractor: AbstractorResult;
  runner: RunnerResult;
}

export interface PipelineOptions {
  headless?: boolean;
  context?: Array<{ role: 'user' | 'assistant'; content: string }>;
  model?: string;
}
