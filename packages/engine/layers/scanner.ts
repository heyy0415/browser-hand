/**
 * Scanner 层 — 通过 Node.js 子进程调用 Playwright 扫描页面
 * 提取所有可见可交互元素并结构化返回
 */

import { logger } from '@@browser-hand/engine-shared/util';
import type { ScannerResult, ScanOptions } from '@@browser-hand/engine-shared/type';

const log = (msg: string, meta?: unknown) => logger.info('scanner', msg, meta);

const WORKER_PATH = import.meta.dir + '/scanner-worker.mjs';

// ── Worker 消息协议 ──────────────────────────────────────────────

interface WorkerProgress {
  type: 'progress';
  data: string;
}

interface WorkerResult {
  type: 'result';
  data: ScannerResult;
}

interface WorkerError {
  type: 'error';
  data: string;
}

type WorkerMessage = WorkerProgress | WorkerResult | WorkerError;

// ── 回调接口 ─────────────────────────────────────────────────────

export interface ScanCallbacks {
  /** 进度回调 */
  onProgress?: (message: string) => void;
  /** 扫描完成回调 */
  onResult?: (result: ScannerResult) => void;
  /** 错误回调 */
  onError?: (error: string) => void;
}

// ── 核心: spawn Node.js 子进程 ───────────────────────────────────

function spawnScanner(
  url: string,
  options: Required<Pick<ScanOptions, 'pageId' | 'timeout' | 'autoScroll' | 'scanFrames'>>,
  callbacks: ScanCallbacks,
): Promise<ScannerResult> {
  return new Promise((resolve, reject) => {
    const child = Bun.spawn(
      [
        'node',
        WORKER_PATH,
        '--url', url,
        '--pageId', options.pageId,
        '--timeout', String(options.timeout),
        '--autoScroll', String(options.autoScroll),
        '--scanFrames', String(options.scanFrames),
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    let stdoutBuffer = '';
    let stderrOutput = '';
    let resolved = false;

    // ── 逐行读取 stdout ──
    (async () => {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        stdoutBuffer += decoder.decode(value, { stream: true });

        // 按换行切割，最后一行可能不完整
        const lines = stdoutBuffer.split('\n');
        const lastLine = lines.pop();
        stdoutBuffer = lastLine ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const msg: WorkerMessage = JSON.parse(trimmed);

            switch (msg.type) {
              case 'progress':
                callbacks.onProgress?.(msg.data);
                log(msg.data);
                break;

              case 'result':
                if (!resolved) {
                  resolved = true;
                  callbacks.onResult?.(msg.data);
                  resolve(msg.data);
                }
                break;

              case 'error':
                if (!resolved) {
                  resolved = true;
                  const errMsg = msg.data;
                  callbacks.onError?.(errMsg);
                  reject(new Error(errMsg));
                }
                break;
            }
          } catch {
            // 非 JSON 行（调试输出），忽略
          }
        }
      }
    })();

    // ── 读取 stderr ──
    (async () => {
      const reader = child.stderr.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrOutput += decoder.decode(value, { stream: true });
      }
    })();

    // ── 子进程退出处理 ──
    child.exited.then((code) => {
      if (resolved) return;

      if (code !== 0) {
        const errMsg = `Scanner worker exited with code ${code}: ${stderrOutput.trim()}`;
        callbacks.onError?.(errMsg);
        reject(new Error(errMsg));
      } else if (!resolved) {
        // 进程正常退出但没收到 result，可能 stdout 没输出完整
        const errMsg = `Scanner worker exited without result. stderr: ${stderrOutput.trim()}`;
        callbacks.onError?.(errMsg);
        reject(new Error(errMsg));
      }
    });
  });
}

// ── 对外接口 ─────────────────────────────────────────────────────

/**
 * 扫描指定 URL 的页面，返回 ScannerResult
 *
 * @example
 * ```ts
 * const result = await scanPage('https://example.com', {
 *   onProgress: (msg) => console.log(msg),
 * });
 * console.log(`Found ${result.elements.length} elements`);
 * ```
 */
export async function scanPage(
  url: string,
  options: ScanOptions & ScanCallbacks = {},
): Promise<ScannerResult> {
  const {
    pageId = 'p0',
    timeout = 30_000,
    autoScroll = true,
    scanFrames = true,
    onProgress,
    onResult,
    onError,
  } = options;

  log(`start scan: ${url}`);

  const result = await spawnScanner(
    url,
    { pageId, timeout, autoScroll, scanFrames },
    { onProgress, onResult, onError },
  );

  log(`done: ${result.elements.length} elements from ${url}`);
  return result;
}

/**
 * 扫描并返回 SSE 流（用于 pipeline 集成）
 */
export async function scanPageWithStream(
  url: string,
  options: ScanOptions & ScanCallbacks = {},
): Promise<{
  stream: ReadableStream<Uint8Array>;
  result: Promise<ScannerResult>;
}> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
      for (const chunk of chunks) ctrl.enqueue(chunk);
      chunks.length = 0;
    },
    cancel() {
      controller = null;
    },
  });

  function push(event: string, data: unknown) {
    const raw = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const chunk = encoder.encode(raw);
    if (controller) {
      try { controller.enqueue(chunk); } catch { /* closed */ }
    } else {
      chunks.push(chunk);
    }
  }

  const result = (async () => {
    try {
      push('start', { step: 'scanner', url });

      const scanResult = await scanPage(url, {
        ...options,
        onProgress: (msg) => {
          push('delta', { step: 'scanner', message: msg });
          options.onProgress?.(msg);
        },
        onResult: (res) => {
          options.onResult?.(res);
        },
        onError: (err) => {
          push('error', { step: 'scanner', message: err });
          options.onError?.(err);
        },
      });

      push('completed', {
        step: 'scanner',
        elementCount: scanResult.elements.length,
        url: scanResult.url,
      });

      try {
        if (controller) {
          (controller as ReadableStreamDefaultController<Uint8Array>).close();
        }
      } catch {}
      return scanResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      push('error', { step: 'scanner', message: msg });
      try {
        if (controller) {
          (controller as ReadableStreamDefaultController<Uint8Array>).close();
        }
      } catch {}
      throw err;
    }
  })();

  return { stream, result };
}
