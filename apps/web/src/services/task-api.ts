/**
 * SSE 流式任务提交
 */

const TASK_API_URL = '/api/task';

export interface TaskStreamOptions {
  headless?: boolean;
  sessionId: string;
  model?: string;
  context?: Array<{ role: 'user' | 'assistant'; content: string }>;
  onEvent: (event: { event: string; data: unknown }) => void;
  onError: (error: Error) => void;
  onComplete: () => void;
}

export async function submitTask(question: string, options: TaskStreamOptions): Promise<void> {
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
    options.onError(new Error(`HTTP ${response.status}`));
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    options.onError(new Error('No response body'));
    return;
  }

  const decoder = new TextDecoder();
  let currentEvent = 'chunk';
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const segments = buffer.split('\n\n');
      buffer = segments.pop() ?? '';

      for (const segment of segments) {
        const lines = segment.split('\n');
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
            continue;
          }
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            try {
              const parsed = JSON.parse(data);
              // 新格式：data 是 { event, data, timestamp, sessionId }
              // 兼容处理：如果 parsed.data 存在则使用，否则使用整个 parsed
              const eventData = parsed.data !== undefined ? parsed.data : parsed;
              options.onEvent({ event: currentEvent, data: eventData });
            } catch {
              options.onEvent({ event: currentEvent, data });
            }
          }
        }
      }
    }
  } catch (error) {
    options.onError(error instanceof Error ? error : new Error(String(error)));
    return;
  }

  options.onComplete();
}
