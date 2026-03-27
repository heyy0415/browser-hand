/** engine — 全部类型 */

// ============================================================
//  Intention 层
// ============================================================

export interface IntentionResult {
  isWebAction: boolean;
  reason: string;
  flow: Array<{
    step: number;
    action: string;
    params: Record<string, unknown>;
  }>;
  meta: {
    startUrl: string | null;
    pageType: string | null;
    crossPage: boolean;
    summary: string;
  };
}

// ============================================================
//  Scanner 层
// ============================================================

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
  | 'canvas';

export interface ElementSnapshot {
  uid: string;
  tag: string;
  role: SemanticRole;
  /** CSS 选择器 */
  selector: string;
  /** 功能描述 */
  label: string;
  /** 元素状态 */
  state: Record<string, unknown>;
  /** iframe / shadow 路径 */
  framePath: string[];
}

export interface ScannerResult {
  url: string;
  elements: ElementSnapshot[];
}

// ============================================================
//  Vector 层（默认透传）
// ============================================================

export interface VectorResult extends ScannerResult {}

// ============================================================
//  Abstractor 层
// ============================================================

export interface AbstractorResult {
  /** 伪代码操作列表，每行一条 */
  code: string[];
  /** 中文摘要 */
  summary: string;
}

// ============================================================
//  Runner 层
// ============================================================

export interface ActionResult {
  step: number;
  success: boolean;
  data?: unknown;
  error?: string;
  screenshot?: string;
}

export interface RunnerResult {
  results: ActionResult[];
}

// ============================================================
//  Pipeline / SSE
// ============================================================

export const SSE_EVENT_TYPES = [
  'start',
  'chunk',
  'tool_call',
  'tool_result',
  'action',
  'screenshot',
  'error',
  'done',
  'step_start',
  'step_complete',
] as const;
export type SSEEventType = (typeof SSE_EVENT_TYPES)[number];

export interface SSEEvent<T = unknown> {
  event: SSEEventType;
  data: T;
}
