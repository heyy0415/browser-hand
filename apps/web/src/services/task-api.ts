/**
 * Task API 服务
 * 负责与后端 /api/task 接口通信，处理流式 SSE 响应
 */

import type { SSEEvent } from '@browser-hand/core';

const TASK_API_URL = '/api/task';

export interface TaskStreamOptions {
  headless?: boolean;
  sessionId?: string;
  model?: string;
  context?: Array<{ role: 'user' | 'assistant'; content: string }>;
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
        headless: options.headless,
        sessionId: options.sessionId,
        model: options.model,
        context: options.context,
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
            options.onEvent({ event: currentEvent as SSEEvent['event'], data: parsed });
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
