/**
 * Bun 前端开发服务器
 * - 使用 Bun.build() 按需打包 React 应用
 * - 代理 /api 请求到后端
 * - 支持静态文件服务与热重载
 * - 监听 src/ 变化自动重新打包并推送刷新
 */

export {};

import { watch } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.WEB_PORT) || 5173;
const API_TARGET = process.env.API_URL || 'http://localhost:3000';
const BUILD_DIR = `${import.meta.dir}/.dev-cache`;
const SRC_DIR = join(import.meta.dir, 'src');

const indexHtml = await Bun.file('index.html').text();

// ── 热重载：管理 SSE 客户端连接 ──────────────────────────────────

const hotClients = new Set<ReadableStreamDefaultController>();
let buildHash = Date.now();

function broadcastReload() {
  buildHash = Date.now();
  const encoder = new TextEncoder();
  for (const ctrl of hotClients) {
    try {
      ctrl.enqueue(encoder.encode(`event: reload\ndata: ${buildHash}\n\n`));
    } catch {
      hotClients.delete(ctrl);
    }
  }
}

// ── 构建逻辑 ────────────────────────────────────────────────────

async function doBuild(): Promise<boolean> {
  const result = await Bun.build({
    entrypoints: ['src/main.tsx'],
    outdir: BUILD_DIR,
    target: 'browser',
    minify: false,
    sourcemap: 'inline',
    define: {
      'process.env.NODE_ENV': JSON.stringify('development'),
    },
  });
  if (!result.success) {
    console.error('[web] Build failed:', result.logs);
    return false;
  }
  return true;
}

// 初次构建
await doBuild();
console.log('[web] Initial build done');

// ── 文件监听：src/ 变化时重新打包 + 推送刷新 ─────────────────────

let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

function onFileChange(_event: string, filename: string | null) {
  if (!filename) return;
  // 忽略临时文件和 .d.ts
  if (filename.endsWith('.d.ts') || filename.startsWith('.')) return;

  // 防抖：300ms 内多次变更只触发一次构建
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(async () => {
    console.log(`[web] File changed: ${filename}, rebuilding...`);
    const ok = await doBuild();
    if (ok) {
      console.log('[web] Rebuild done, notifying clients');
      broadcastReload();
    }
    rebuildTimer = null;
  }, 300);
}

// 递归监听 src 目录
watch(SRC_DIR, { recursive: true }, onFileChange);
console.log(`[web] Watching ${SRC_DIR} for changes`);

// 也监听 index.html 变化
watch(join(import.meta.dir, 'index.html'), onFileChange);

// ── MIME 类型 ───────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function getMimeType(pathname: string): string {
  const dot = pathname.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  return MIME_MAP[pathname.slice(dot)] || 'application/octet-stream';
}

// ── HTTP 服务 ───────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // API 代理
    if (url.pathname.startsWith('/api/')) {
      const targetUrl = `${API_TARGET}${url.pathname}${url.search}`;
      return fetch(targetUrl, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
    }

    // HTML 入口（注入热重载脚本）
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = indexHtml.replace(
        '</head>',
        `<script>
          const es = new EventSource('/__hot__');
          es.addEventListener('reload', () => {
            console.log('[hot] Reloading...');
            location.reload();
          });
        </script></head>`,
      );
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // 热重载事件流
    if (url.pathname === '/__hot__') {
      const stream = new ReadableStream({
        start(controller) {
          // 发送初始连接事件（使用命名事件，避免触发 reload）
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(`event: connected\ndata: ${buildHash}\n\n`));
          hotClients.add(controller);

          // 心跳保活
          const heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`: heartbeat\n\n`));
            } catch {
              hotClients.delete(controller);
              clearInterval(heartbeat);
            }
          }, 15_000);

          req.signal.addEventListener('abort', () => {
            hotClients.delete(controller);
            clearInterval(heartbeat);
            try { controller.close(); } catch {}
          });
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    // 构建产物（main.js, main.css, assets）
    const buildPath = `${BUILD_DIR}${url.pathname}`;
    const buildFile = Bun.file(buildPath);
    if (await buildFile.exists()) {
      return new Response(buildFile, {
        headers: {
          'Content-Type': getMimeType(url.pathname),
          'Cache-Control': 'no-cache',
        },
      });
    }

    // 静态文件回退
    const staticPath = `${import.meta.dir}${url.pathname}`;
    const staticFile = Bun.file(staticPath);
    if (await staticFile.exists()) {
      return new Response(staticFile, {
        headers: {
          'Content-Type': getMimeType(url.pathname),
          'Cache-Control': 'no-cache',
        },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
});

console.log(`[web] Dev server: http://localhost:${PORT}`);
