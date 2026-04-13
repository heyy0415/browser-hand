/** @browser-hand/core — 类型定义 */

// ═══════════════════════════════════════════════════════════════════════
// Intention 层类型定义（优化后）
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

/** 注意：搜索操作已拆分为 fill + click 两步，不再使用 'search' 类型 */

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

/** 元素特征提示，帮助 Vector 层筛选 */
export interface ElementHint {
  /** 期望的角色类型 */
  roleHint?: string[];
  /** 期望的交互类型 */
  interactionHint?: 'input' | 'submit' | 'selection' | 'navigation' | 'toggle' | 'action';
  /** 期望的功能区域 */
  zoneHint?: string[];
  /** 关键词匹配 */
  keywords?: string[];
}

/** 优化后的操作步骤结构 */
export interface IntentionStep {
  /** 标准化的动作类型 */
  action: ActionType;
  /** 操作类型分类 */
  category: StepCategory;
  /** 目标标识 */
  target: string;
  /** 目标类型 */
  targetType: TargetType;
  /** 操作描述 */
  desc: string;
  /** 输入值（用于 search/fill/select 等操作） */
  value?: string;
  /** 元素特征提示 */
  elementHint?: ElementHint;
  /** 预期结果描述 */
  expectedOutcome?: string;
  /** 用于向量检索的查询文本（自动生成） */
  searchQuery?: string;
}

/** 兼容旧格式的步骤 */
export interface IntentionStepLegacy {
  action: string;
  target: string;
  desc: string;
}

export type IntentionStatus = 'success' | 'clarification_needed' | 'out_of_scope';

export interface IntentionResult {
  status: IntentionStatus;
  reply: string | null;
  flow: IntentionStep[] | null;
  question: string[] | null;
}

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
  | 'unknown';

/** 元素的语义描述，用于让 LLM 理解元素功能 */
export interface ElementSemantics {
  /** 人类可读的功能描述，如 "搜索按钮"、"提交表单" */
  description: string;
  /** 元素所属的功能区域 */
  zone: FunctionalZone;
  /** 父元素的简要描述 */
  parentContext?: string;
  /** 关联元素信息（如表单关联的 label） */
  relatedLabel?: string;
  /** 视觉提示（图标类名、颜色等） */
  visualHints?: string[];
  /** 元素的交互类型提示 */
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
  /** 新增：语义信息 */
  semantics?: ElementSemantics;
  /** 用于向量检索的文本表示（运行时生成） */
  embeddingText?: string;
  /** 向量表示（运行时生成） */
  embedding?: number[];
}

/** 页面可见文本节点（标题、段落、图片等非交互元素） */
export interface VisibleTextNode {
  tag: string;
  text: string;
}

export interface ScannerResult {
  url: string;
  title: string;
  elements: ElementSnapshot[];
  visibleText: VisibleTextNode[];
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
  /** 该区域的元素数量 */
  elementCount: number;
  /** 该区域的主要功能描述 */
  description: string;
  /** 该区域的关键元素示例 */
  keyElements: string[];
}

/** 页面能力概述 */
export interface PageCapabilities {
  /** 页面主要功能（1-3个） */
  mainFunctions: string[];
  /** 页面功能区域分布 */
  zones: PageZone[];
  /** 页面类型判断 */
  pageType: 'search-engine' | 'e-commerce' | 'social-media' | 'content' | 'form' | 'dashboard' | 'unknown';
  /** 是否有搜索功能 */
  hasSearch: boolean;
  /** 是否有登录功能 */
  hasLogin: boolean;
  /** 是否有表单提交 */
  hasForm: boolean;
}

export interface VectorMatch {
  element: ElementSnapshot;
  /** 相似度分数（0-1） */
  score: number;
  /** 匹配原因说明 */
  reason: string;
  /** 匹配的步骤索引（对应 flow 中的位置） */
  matchedStep?: number;
  /** 匹配类型 */
  matchType: 'embedding' | 'keyword' | 'hint';
}

export interface VectorResult {
  url: string;
  title: string;
  matches: VectorMatch[];
  elements: ElementSnapshot[];
  visibleText: VisibleTextNode[];
  /** 新增：页面能力概述 */
  capabilities?: PageCapabilities;
  /** 新增：按区域分组的元素 */
  groupedElements?: Record<FunctionalZone, ElementSnapshot[]>;
  /** 向量检索使用的查询向量 */
  queryEmbedding?: number[];
  success: boolean;
  message: string;
}

export interface VectorOptions {
  topK?: number;
  minScore?: number;
}

export interface AbstractorResult {
  code: string[];
  summary: string;
  thinking?: string;
  meta?: {
    totalSteps: number;
    estimatedComplexity: 'low' | 'medium' | 'high';
    requiresAuth?: boolean;
  };
}

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

export interface ActionResult {
  step: number;
  success: boolean;
  data?: {
    type?: ActionResultType;
    code?: string;
    pseudoCode?: string;
    script?: string;
    /** 操作类型分类 */
    category?: StepCategory;
    target?: {
      uid: string;
      selector: string;
      tag: string;
      role: SemanticRole;
    };
    /** 提取的内容（extraction 类型） */
    extracted?: string | string[];
    [key: string]: unknown;
  };
  error?: string;
  screenshot?: string;
}

export interface RunnerResult {
  results: ActionResult[];
  success: boolean;
  duration?: number;
  /** 提取的内容列表 */
  extractedContents?: Array<{ selector: string; content: string | string[] }>;
}

export interface RunnerOptions {
  headless?: boolean;
  stepDelay?: number;
  screenshotPerStep?: boolean;
  actionTimeout?: number;
}

export const SSE_EVENT_TYPES = [
  'conversation_start',
  'conversation_delta',
  'conversation_delta_completed',
  'conversation_completed',
  'conversation_done',
  'error',
] as const;

export type SSEEventType = (typeof SSE_EVENT_TYPES)[number];

export interface SSEEvent<T = unknown> {
  event: SSEEventType;
  data: T;
}

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
