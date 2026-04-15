/** 前端类型定义 */

/** 流水线层级状态 */
export type StepState = 'pending' | 'running' | 'done' | 'error';

/** 流水线整体状态 */
export interface PipelineState {
  intention: StepState;
  scanner: StepState;
  vector: StepState;
  abstractor: StepState;
  runner: StepState;
}

/** Runner 执行步骤信息 */
export interface RunnerStepInfo {
  lineNumber: number;
  code: string;
  action: string;
  status: 'running' | 'success' | 'failed' | 'skipped' | 'warning';
  elapsedMs?: number;
  error?: string;
  screenshot?: string;
  /** 该步骤提取到的文本内容 */
  extractedText?: string;
  /** 该步骤截图的 base64 */
  extractedScreenshot?: string;
}

/** 提取内容 */
export interface ExtractedContent {
  type: 'text' | 'screenshot' | 'mixed';
  textResults: Array<{ selector: string; text: string; lineNumber: number }>;
  screenshotResults: string[];
}

/** 思考过程状态 */
export interface ThinkingState {
  content: string;
  completed: boolean;
}

/** 消息类型 */
export interface Message {
  id: string;
  type: 'user' | 'assistant';
  content?: string;
  completed?: boolean;
  isError?: boolean;
  errorMessage?: string;
  asking?: {
    reply: string;
    questions: string[];
  };

  // 思考过程
  thinking?: ThinkingState;

  // 流水线状态
  pipeline?: PipelineState;

  // Runner 执行步骤
  runnerSteps?: RunnerStepInfo[];

  // 提取内容
  extractedContent?: ExtractedContent;
}

/** 会话条目 */
export interface SessionItem {
  id: string;
  title: string;
  createdAt: number;
  messages: Message[];
}
