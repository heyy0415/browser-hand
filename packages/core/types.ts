/** @browser-hand/core — 类型定义 (v2.0 双轨分离 + 智能网关 + 事件驱动重入) */

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

/** 元素的功能区域类型（Scanner 内部使用） */
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

/** 空间词：将视口坐标离散化为 LLM 可理解的空间位置 */
export type SpatialWord =
  | 'top-left' | 'top-center' | 'top-right'
  | 'mid-left' | 'mid-center' | 'mid-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

/** 根据视口归一化坐标计算离散空间词 */
export function computeSpatialWord(xRatio: number, yRatio: number): SpatialWord {
  const yBucket = yRatio < 0.33 ? 'top' : yRatio < 0.66 ? 'mid' : 'bottom';
  const xBucket = xRatio < 0.33 ? 'left' : xRatio < 0.66 ? 'center' : 'right';
  return `${yBucket}-${xBucket}` as SpatialWord;
}

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

/** 操作步骤结构 */
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
  /** 预期祖先路径（如 "header > nav"） */
  ancestorPath?: string;
  /** 预期结果描述 */
  expectedOutcome: string;
  /** 用于向量检索的查询文本（运行时生成） */
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
// Scanner 层类型定义（v2.0 双轨分离）
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

/**
 * 轨道一：给 LLM 看的极简纯文本（包含空间基因）
 * 每行以 [index] 前缀编号，与 ElementMap 索引对应
 * 示例：
 * [0] <header data-zone="header" data-pos="top-center">
 * [1] <input placeholder="搜索" data-zone="search" data-pos="top-center">
 * [2] <button data-zone="search" data-pos="top-center">搜索</button>
 */
export type DomText = string;

/**
 * 轨道二：给 Vector/Runner 算法用的隐藏映射表
 * index 与 domText 中的 [index] 前缀一一对应
 */
export interface ElementMap {
  [index: number]: {
    /** 可穿透 Shadow DOM 的 CSS Selector（含 >>> 穿透符） */
    selector: string;
    /** 像素坐标 + 视口归一化 */
    rect: { x: number; y: number; w: number; h: number; centerY: number; yRatio: number };
    /** 功能区 (header/footer/modal/search/...) */
    zone: string;
    /** 交互角色 (button/input/link/searchbox/...) */
    role: string;
    /** 原始拼接文本（用于 Plan A 算法 includes 匹配） */
    rawText: string;
    /** 优化过的 Embedding 文本（仅 Plan B 使用） */
    embeddingText: string;
    /** Shadow DOM 宿主链（从外到内），如 ["my-dialog", "x-form"]；无 Shadow DOM 时省略 */
    shadowHosts?: string[];
  };
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

/**
 * Scanner 输出（v2.0 双轨分离）
 * domText 给 LLM，elementMap 给算法
 */
export interface ScannerResult {
  url: string;
  title: string;
  /** 轨道一：带空间属性的极简纯文本 */
  domText: DomText;
  /** 轨道二：结构化坐标元数据 */
  elementMap: ElementMap;
  /** 页面可见文本（辅助上下文） */
  visibleText: VisibleTextNode[];
  /** 视口尺寸 */
  viewport: { width: number; height: number };
  timestamp: number;
  /** 扫描到的元素总数 */
  totalElements: number;
  /** 页面摘要 */
  pageSummary: PageSummary;
  /** 区域包围盒 */
  zonesBoundingBox: Record<string, ElementRect>;
}

export interface ScanOptions {
  pageId?: string;
  timeout?: number;
  autoScroll?: boolean;
  scanFrames?: boolean;
}

/** 页面功能区域描述 */
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
// Vector 层类型定义（v2.0 智能网关）
// ═══════════════════════════════════════════════════════════════════════

/** Vector 网关路由类型 */
export type VectorGatewayRoute = 'PLAN_A_HARDFILTER' | 'PLAN_B_SEMANTIC';

/** Vector 智能网关输出 */
export interface VectorGatewayResult {
  /** 过滤后的精简 domText */
  filteredDomText: DomText;
  /** 走了哪条路由 */
  route: VectorGatewayRoute;
  /** 压缩前 domText 行数 */
  originalLines: number;
  /** 压缩后行数 */
  filteredLines: number;
  /** 压缩比描述，如 "98%" */
  compressionRatio: string;
  /** Plan B 语义降级时的匹配结果（Plan A 时为空） */
  semanticMatches?: Array<{
    index: number;
    score: number;
    matchedStep: number;
  }>;
}

// ═══════════════════════════════════════════════════════════════════════
// Abstractor 层类型定义
// ═══════════════════════════════════════════════════════════════════════

/** 伪代码行（v2.0 索引格式） */
export interface PseudoCodeLine {
  lineNumber: number;
  /** 伪代码，如 "click([3])" 或 "fill([2], '手机')" */
  code: string;
  /** 对应的 FlowStep 索引 */
  sourceStep: number;
  /** 匹配到的 elementMap 索引（从 code 中提取） */
  matchedElementIndex: number | null;
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
// Runner 层类型定义（v2.0 事件驱动重入）
// ═══════════════════════════════════════════════════════════════════════

/** Runner 每步执行结果 */
export interface StepResult {
  lineNumber: number;
  code: string;
  status: 'success' | 'failed' | 'skipped' | 'warning';
  action: ActionType;
  /** 真实 CSS 选择器（从 elementMap 索引解析） */
  selector: string | null;
  /** elementMap 索引（从伪代码解析） */
  elementIndex: number | null;
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

/** 页面突变类型 */
export type MutationResultType = 'URL_CHANGE' | 'DOM_MUTATION' | 'NONE';

/** 页面突变检测结果 */
export interface MutationResult {
  type: MutationResultType;
  /** URL_CHANGE 时的目标 URL */
  newUrl?: string;
  /** DOM_MUTATION 时的描述 */
  description?: string;
}

/** 状态变更记录（重入历史） */
export interface StateChangeRecord {
  /** 触发重入的步骤索引 */
  triggeredByStepIndex: number;
  /** 突变类型 */
  mutationType: MutationResultType;
  /** 突变描述 */
  reason: string;
  /** 跳转目标 URL（URL_CHANGE 时） */
  targetUrl?: string;
  /** 重入时剩余的 FlowStep 数量 */
  remainingStepsCount: number;
}

/** Runner 输出 */
export interface RunnerResult {
  success: boolean;
  steps: StepResult[];
  extractedContent: ExtractedContent | null;
  finalScreenshot: string | null;
  error: RunnerError | null;
  totalElapsedMs: number;
  results: StepResult[];
  duration?: number;
  extractedContents?: Array<{ selector: string; content: string | string[] }>;
  /** v2.0: 重入历史记录 */
  stateChanges: StateChangeRecord[];
  /** v2.0: 总执行轮数（含重入） */
  totalRounds: number;
  /** 已执行的伪代码行数 */
  executedLines: number;
}

export interface RunnerOptions {
  headless?: boolean;
  stepDelay?: number;
  screenshotPerStep?: boolean;
  actionTimeout?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// SSE 事件类型定义（v2.0 扩展）
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
  // Vector（v2.0 智能网关）
  'vector.start',
  'vector.gateway',
  'vector.done',
  // Abstractor
  'abstractor.start',
  'abstractor.thinking',
  'abstractor.error',
  'abstractor.done',
  // Runner
  'runner.start',
  'runner.step-start',
  'runner.step-done',
  'runner.step-error',
  'runner.extract',
  'runner.done',
  // 状态突变（v2.0 重入核心）
  'state_change_detected',
  // Pipeline（多轮）
  'pipeline.round-start',
] as const;

export type SSEEventType = (typeof SSE_EVENT_TYPES)[number];

export interface SSEEvent<T = unknown> {
  event: SSEEventType;
  data: T;
  timestamp: number;
  sessionId: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Pipeline 类型定义（v2.0 精简）
// ═══════════════════════════════════════════════════════════════════════

/** 单轮 Pipeline 执行结果（v2.0：由 Runner 状态机内部管理，Pipeline 不再构建） */
export interface PipelineRound {
  /** 轮次编号（从 0 开始） */
  roundIndex: number;
  /** 本轮扫描的 URL */
  scannedUrl: string;
  /** 本轮处理的 flow step 索引范围 */
  stepRange: { start: number; end: number };
  /** 本轮是否发生了页面状态突变 */
  stateChange: StateChangeRecord | null;
}

/** Pipeline 输出 (v2.0 精简) — Scanner/Vector/Abstractor 由 Runner 内部调用 */
export interface PipelineResult {
  intention: IntentionResult;
  runner: RunnerResult;
  totalRounds: number;
}

export interface PipelineOptions {
  headless?: boolean;
  context?: Array<{ role: 'user' | 'assistant'; content: string }>;
  model?: string;
  /** 最大执行轮次（默认 5），防止无限循环 */
  maxRounds?: number;
}
