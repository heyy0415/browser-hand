/** engine-shared 常量配置 */

export const API_BASE_URL = process.env.VITE_API_URL || 'http://localhost:3000';

export const LLM_CONFIG = {
  apiKey: process.env.LLM_API_KEY || '',
  baseUrl: process.env.LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: process.env.LLM_MODEL || 'qwen-flash',
};

export const LLM_MAX_RETRIES = 3;
export const LLM_RETRY_BASE_DELAY = 1000;

export const INTENT_SYSTEM_PROMPT = `
你是浏览器自动化意图解析器。
请将用户自然语言解析为结构化 JSON，格式如下：
{
  "flow": [{ "action": "类型", "target": "目标", "desc": "描述" }]
}

规则：
1. flow 按执行顺序输出。
2. 如果包含打开网站语义，第一步必须是 navigate。
3. 只输出 JSON，不输出其他内容。
`;

export const INTENT_USER_PROMPT = (input: string) => input;
