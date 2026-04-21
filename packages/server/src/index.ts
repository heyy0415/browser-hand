/**
 * Bun HTTP Server 入口
 */

import { handleRequest } from "./routes";

const PORT = parseInt(process.env.PORT || "3001");

const server = Bun.serve({
  port: PORT,
  // 传递 server 实例给路由，以便 SSE 请求调用 server.timeout(req, 0) 禁用空闲超时
  fetch: (req, server) => handleRequest(req, server),
});

console.log(`Browser Hand server running at http://localhost:${PORT}`);
