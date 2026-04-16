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

/** Vector 智能网关路由信息 */
export interface VectorGatewayInfo {
  /** 路由类型：Plan A 硬过滤 / Plan B 语义降级 */
  route: 'PLAN_A_HARDFILTER' | 'PLAN_B_SEMANTIC';
  /** 压缩前 domText 行数 */
  originalLines: number;
  /** 压缩后行数 */
  filteredLines: number;
  /** 压缩比描述，如 "98%" */
  compressionRatio: string;
}

/** 页面状态突变信息（重入扫描触发） */
export interface StateChangeInfo {
  /** 突变原因 */
  reason: string;
  /** 跳转目标 URL（URL_CHANGE 时） */
  target?: string;
}

/** 单轮执行信息 */
export interface RoundInfo {
  /** 轮次编号（从 0 开始） */
  roundIndex: number;
  /** 该轮的流水线状态 */
  pipeline: PipelineState;
  /** 该轮的 Runner 执行步骤 */
  runnerSteps: RunnerStepInfo[];
  /** 该轮的提取内容 */
  extractedContent?: ExtractedContent;
  /** 该轮的 Vector 网关路由信息 */
  vectorGateway?: VectorGatewayInfo;
  /** 该轮的状态突变记录 */
  stateChanges?: StateChangeInfo[];
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

  // 当前轮的流水线状态（向后兼容，也用于当前正在执行的轮次）
  pipeline?: PipelineState;

  // 当前轮的 Runner 执行步骤（向后兼容）
  runnerSteps?: RunnerStepInfo[];

  // 提取内容
  extractedContent?: ExtractedContent;

  // Vector 智能网关路由信息
  vectorGateway?: VectorGatewayInfo;

  // 状态突变记录（重入扫描）
  stateChanges?: StateChangeInfo[];

  // 多轮执行：所有轮次信息
  rounds?: RoundInfo[];
}

/** 会话条目 */
export interface SessionItem {
  id: string;
  title: string;
  createdAt: number;
  messages: Message[];
}
