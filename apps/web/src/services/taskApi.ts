/**
 * Task API 服务
 * 负责与后端 /api/task 接口通信，处理流式 SSE 响应
 */

import type { SSEEvent } from '@browser-hand/engine';

const API_BASE_URL = import.meta.env.VITE_API_URL?.trim();
const TASK_API_URL = API_BASE_URL ? `${API_BASE_URL}/api/task` : '/api/task';

export interface TaskStreamOptions {
  headless?: boolean;
  onEvent: (event: SSEEvent) => void;
  onError: (error: Error) => void;
  onComplete: () => void;
}

export async function submitTask(
  question: string,
  options: TaskStreamOptions,
): Promise<void> {
  try {
    const response = await fetch(TASK_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        headless: options.headless
      }),
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
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      const segments = buffer.split('\n\n');
      buffer = segments.pop() ?? '';

      for (const segment of segments) {
        if (!segment.trim()) {
          continue;
        }

        const lines = segment.split('\n');
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
            continue;
          }

          if (!line.startsWith('data: ')) {
            continue;
          }

          const data = line.slice(6).trim();
          if (!data) {
            continue;
          }

          try {
            const parsed = JSON.parse(data);
            const normalizedData =
              typeof parsed === 'string'
                ? parsed
                : typeof parsed?.data === 'string'
                  ? parsed.data
                  : parsed;

            options.onEvent({ event: currentEvent as SSEEvent['event'], data: normalizedData });
          } catch {
            options.onEvent({ event: currentEvent as SSEEvent['event'], data });
          }
        }
      }
    }

    options.onComplete();
  } catch (error) {
    options.onError(error instanceof Error ? error : new Error(String(error)));
  }
}
