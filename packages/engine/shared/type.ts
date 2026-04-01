/** engine-shared 类型定义 */

export interface IntentionStep {
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

export interface VectorMatch {
  element: ElementSnapshot;
  score: number;
  reason: string;
}

export interface VectorResult {
  url: string;
  title: string;
  matches: VectorMatch[];
  elements: ElementSnapshot[];
  visibleText: VisibleTextNode[];
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
    target?: {
      uid: string;
      selector: string;
      tag: string;
      role: SemanticRole;
    };
    extracted?: unknown;
    [key: string]: unknown;
  };
  error?: string;
  screenshot?: string;
}

export interface RunnerResult {
  results: ActionResult[];
  success: boolean;
  duration?: number;
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
