/** 前端类型定义 */

export interface Message {
  id: string;
  type: 'user' | 'assistant';
  /** 思考区：仅累积 intention/abstractor 的 delta 文本 */
  content: string;
  completed?: boolean;
  isError?: boolean;
  /** 错误区 */
  errorMessage?: string;
  asking?: {
    reply: string;
    questions: string[];
  };
  /** 结果区：vector/abstractor/runner 的 completed 数据 */
  results?: Array<{ step: string; status: string; data: unknown }>;
}

export interface SessionItem {
  id: string;
  title: string;
  createdAt: number;
  messages: Message[];
}
