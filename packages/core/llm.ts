/** @browser-hand/core — LLM、SSE 流、日志、JSON 解析等工具方法 */

import OpenAI from 'openai';
import { LLM_CONFIG } from './constants';
import type { SSEEventType } from './types';

export function createLLM() {
  return new OpenAI({
    apiKey: LLM_CONFIG.apiKey,
    baseURL: LLM_CONFIG.baseUrl,
    timeout: 120_000,
    maxRetries: 1,
  });
}

export async function* streamLLM(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  options: { model?: string; temperature?: number } = {},
): AsyncGenerator<string, void, unknown> {
  const client = createLLM();

  const stream = await client.chat.completions.create({
    model: options.model || LLM_CONFIG.model,
    messages,
    temperature: options.temperature ?? 0,
    stream: true,
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      yield delta;
    }
  }
}

export function createSSEStream(): {
  stream: ReadableStream<Uint8Array>;
  send: (event: SSEEventType, data: unknown, sessionId?: string) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const pending: Uint8Array[] = [];

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      while (pending.length > 0) {
        const chunk = pending.shift();
        if (chunk) {
          c.enqueue(chunk);
        }
      }
    },
  });

  const send = (event: SSEEventType, data: unknown, sessionId?: string) => {
    const payload = {
      event,
      data,
      timestamp: Date.now(),
      sessionId: sessionId ?? '',
    };
    const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    const encoded = encoder.encode(message);

    if (!controller) {
      pending.push(encoded);
      return;
    }

    controller.enqueue(encoded);
  };

  const close = () => {
    if (!controller) {
      return;
    }

    try {
      controller.close();
    } catch {
      // ignore already closed
    }
  };

  return { stream, send, close };
}

export function parseJSON<T = unknown>(raw: string): T {
  let str = raw.trim();
  if (str.startsWith('```json')) {
    str = str.slice(7);
  } else if (str.startsWith('```')) {
    str = str.slice(3);
  }
  if (str.endsWith('```')) {
    str = str.slice(0, -3);
  }
  return JSON.parse(str.trim()) as T;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}

function log(level: LogLevel, tag: string, message: string, meta?: unknown) {
  if (!shouldLog(level)) {
    return;
  }
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}] [${tag}]`;
  if (meta !== undefined) {
    console.log(`${prefix} ${message}`, meta);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export const logger = {
  debug: (tag: string, msg: string, meta?: unknown) => log('debug', tag, msg, meta),
  info: (tag: string, msg: string, meta?: unknown) => log('info', tag, msg, meta),
  warn: (tag: string, msg: string, meta?: unknown) => log('warn', tag, msg, meta),
  error: (tag: string, msg: string, meta?: unknown) => log('error', tag, msg, meta),
};
