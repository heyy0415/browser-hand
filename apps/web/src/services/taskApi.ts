/**
 * Task API 服务
 * 负责与后端 /api/task 接口通信，处理流式 SSE 响应
 */

import type { SSEEvent } from '@browser-hand/engine';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export interface TaskStreamOptions {
  onEvent: (event: SSEEvent) => void;
  onError: (error: Error) => void;
  onComplete: () => void;
}

/**
 * 调用任务 API 并处理流式响应
 */
export async function submitTask(
  userInput: string,
  options: TaskStreamOptions,
): Promise<void> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userInput }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('无法读取响应流');
    }

    const decoder = new TextDecoder();
    let currentEvent = 'chunk';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        console.log(line)
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
          continue;
        }
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (!data) continue;

          try {
            const parsed = JSON.parse(data);
            console.log(parsed)
            options.onEvent({ event: currentEvent as any, data: parsed });
          } catch (err) {
            // 忽略 JSON 解析错误
          }
        }
      }
    }

    options.onComplete();
  } catch (error) {
    options.onError(error instanceof Error ? error : new Error(String(error)));
  }
}
