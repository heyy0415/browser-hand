/** engine — SSE 工具 + Logger */

import { ChatOpenAI } from "@langchain/openai";
import { LLM_CONFIG } from "./shared/index";
import type { SSEEventType } from "./types";

// ============================================================
//  LLM Factory
// ============================================================

/**
 * 创建 LLM 实例
 * @param temperature - 温度参数（0-1），控制输出的随机性
 */
export function createLLM(temperature = 0, model = '') {
  return new ChatOpenAI({
    model,
    apiKey: LLM_CONFIG.apiKey,
    configuration: { baseURL: LLM_CONFIG.baseUrl },
    temperature,
    timeout: 120_000,
    maxRetries: 1,
  });
}

// ============================================================
//  SSE
// ============================================================

export function createSSEStream(): {
  stream: ReadableStream<Uint8Array>;
  controller: ReadableStreamDefaultController;
  send: (event: SSEEventType, data: unknown) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  const send = (event: SSEEventType, data: unknown) => {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    controller.enqueue(encoder.encode(message));
  };

  const close = () => {
    try {
      controller.close();
    } catch {
      // 流已关闭
    }
  };

  return { stream, controller: controller!, send, close };
}

// ============================================================
//  Logger
// ============================================================

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}

function log(level: LogLevel, tag: string, message: string, meta?: unknown) {
  if (!shouldLog(level)) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}] [${tag}]`;
  if (meta !== undefined) {
    console.log(`${prefix} ${message}`, meta);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export const logger = {
  debug: (tag: string, msg: string, meta?: unknown) =>
    log("debug", tag, msg, meta),
  info: (tag: string, msg: string, meta?: unknown) =>
    log("info", tag, msg, meta),
  warn: (tag: string, msg: string, meta?: unknown) =>
    log("warn", tag, msg, meta),
  error: (tag: string, msg: string, meta?: unknown) =>
    log("error", tag, msg, meta),
};
