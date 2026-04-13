/** Layer 2: Scanner — 通过 Node.js 子进程调用 Playwright 扫描页面 */

import { logger } from '../llm';
import type { ScannerResult, ScanOptions } from '../types';

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

    // 逐行读取 stdout
    (async () => {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        stdoutBuffer += decoder.decode(value, { stream: true });

        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';

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
                  resolve(msg.data);
                }
                break;

              case 'error':
                if (!resolved) {
                  resolved = true;
                  callbacks.onError?.(msg.data);
                  reject(new Error(msg.data));
                }
                break;
            }
          } catch {
            // 非 JSON 行（调试输出），忽略
          }
        }
      }
    })();

    // 读取 stderr
    (async () => {
      const reader = child.stderr.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrOutput += decoder.decode(value, { stream: true });
      }
    })();

    // 子进程退出处理
    child.exited.then((code) => {
      if (resolved) return;

      const errMsg = code !== 0
        ? `Scanner worker exited with code ${code}: ${stderrOutput.trim()}`
        : `Scanner worker exited without result. stderr: ${stderrOutput.trim()}`;

      callbacks.onError?.(errMsg);
      reject(new Error(errMsg));
    });
  });
}

// ── 对外接口 ─────────────────────────────────────────────────────

/**
 * 扫描指定 URL 的页面，返回 ScannerResult
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
    onError,
  } = options;

  log(`start scan: ${url}`);

  const result = await spawnScanner(
    url,
    { pageId, timeout, autoScroll, scanFrames },
    { onProgress, onError },
  );

  log(`done: ${result.elements.length} elements from ${url}`);
  return result;
}
