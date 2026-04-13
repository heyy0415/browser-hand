/**
 * Bun 前端开发服务器
 * - 使用 Bun.build() 按需打包 React 应用
 * - 代理 /api 请求到后端
 * - 支持静态文件服务与热重载
 */

export {};

const PORT = Number(process.env.WEB_PORT) || 5173;
const API_TARGET = process.env.API_URL || 'http://localhost:3000';
const BUILD_DIR = `${import.meta.dir}/.dev-cache`;

const indexHtml = await Bun.file('index.html').text();

let buildDone = false;

async function ensureBuild() {
  if (buildDone) return;
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
    return;
  }
  buildDone = true;
}

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

    // HTML 入口
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = indexHtml.replace(
        '</head>',
        `<script>
          const es = new EventSource('/__hot__');
          es.addEventListener('message', () => { location.reload(); });
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
          const encoder = new TextEncoder();
          const id = setInterval(() => {
            controller.enqueue(encoder.encode(`data: ${Date.now()}\n\n`));
          }, 30_000);

          req.signal.addEventListener('abort', () => {
            clearInterval(id);
            controller.close();
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
    await ensureBuild();
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

console.log(`前端开发服务器：http://localhost:${PORT}`);
