/**
 * API 路由
 * 
 * 提供会话 CRUD 和 SSE 流式聊天 API
 */

import { Agent, type AgentEvent } from "@browser-hand/core";
import {
  createSession,
  getSession,
  getAllSessions,
  deleteSession,
  addMessage,
  type Session,
} from "./store";
import type { ContextManager } from "@browser-hand/core";

/** 活跃的 Agent 实例和上下文（按会话 ID 维护） */
const activeAgents = new Map<string, {
  agent: Agent;
  context: ContextManager | undefined;
}>();

/** 确保会话有对应的 Agent 实例 */
async function getOrCreateAgent(sessionId: string): Promise<{ agent: Agent; context: ContextManager | undefined }> {
  if (!activeAgents.has(sessionId)) {
    const agent = new Agent();
    await agent.start();
    activeAgents.set(sessionId, { agent, context: undefined });
  }
  return activeAgents.get(sessionId)!;
}

/** 清理会话的 Agent 实例 */
async function cleanupAgent(sessionId: string): Promise<void> {
  const entry = activeAgents.get(sessionId);
  if (entry) {
    await entry.agent.stop();
    activeAgents.delete(sessionId);
  }
}

/** 格式化 SSE 事件 */
function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 处理 API 请求 */
export async function handleRequest(req: Request, server: any): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // === 会话 API ===

    // POST /api/sessions - 创建会话
    if (path === "/api/sessions" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const session = await createSession(body.title);
      return Response.json(session, { headers: corsHeaders });
    }

    // GET /api/sessions - 获取会话列表
    if (path === "/api/sessions" && req.method === "GET") {
      const sessions = await getAllSessions();
      return Response.json(sessions, { headers: corsHeaders });
    }

    // GET /api/sessions/:id - 获取会话详情
    const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch && req.method === "GET") {
      const session = await getSession(sessionMatch[1]);
      if (!session) {
        return Response.json({ error: "会话不存在" }, { status: 404, headers: corsHeaders });
      }
      return Response.json(session, { headers: corsHeaders });
    }

    // DELETE /api/sessions/:id - 删除会话
    const sessionDeleteMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionDeleteMatch && req.method === "DELETE") {
      const id = sessionDeleteMatch[1];
      await cleanupAgent(id);
      const deleted = await deleteSession(id);
      if (!deleted) {
        return Response.json({ error: "会话不存在" }, { status: 404, headers: corsHeaders });
      }
      return Response.json({ success: true }, { headers: corsHeaders });
    }

    // POST /api/sessions/:id/chat - 流式聊天（SSE）
    const chatMatch = path.match(/^\/api\/sessions\/([^/]+)\/chat$/);
    if (chatMatch && req.method === "POST") {
      const sessionId = chatMatch[1];
      const body = await req.json().catch(() => ({}));
      const userMessage = body.message;

      if (!userMessage) {
        return Response.json({ error: "缺少 message 参数" }, { status: 400, headers: corsHeaders });
      }

      // 确保会话存在
      let session = await getSession(sessionId);
      if (!session) {
        session = await createSession();
      }

      // 保存用户消息
      await addMessage(sessionId, { role: "user", content: userMessage });

      // 【关键】禁用 Bun 的默认 10 秒空闲超时，否则 SSE 流在无数据写入超过 10 秒后被 Bun 自动关闭
      // 这是 Bun 官方推荐的做法：https://bun.com/docs/guides/http/sse
      server.timeout(req, 0);

      // 创建 SSE 流式响应
      // 使用 ReadableStream + controller.enqueue()（同步写入，无背压问题）
      // 之前的 TransformStream + writer.write() 是异步的，Promise 失败被静默吞掉导致连接断开
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const encoder = new TextEncoder();

      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          streamController = c;
        },
        cancel() {
          // 客户端断开连接时清理心跳
          clearInterval(heartbeat);
        },
      });

      // 同步发送 SSE 事件 - controller.enqueue 是同步的，不存在背压和 Promise 问题
      const sendEvent = (event: string, data: string) => {
        try {
          streamController.enqueue(encoder.encode(formatSSE(event, data)));
        } catch {}
      };

      // SSE 心跳保活：每 5 秒发送一次注释心跳，防止浏览器/代理因空闲断开连接
      // 心跳间隔必须远小于 Bun 默认的 10 秒空闲超时
      const heartbeat = setInterval(() => {
        try {
          // SSE 注释行（以冒号开头）不会触发前端 event，但保持连接活跃
          streamController.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 5000);

      // 收集本次会话的所有消息，结束时一次性批量写入，避免并发 addMessage 的文件竞态
      const pendingMessages: Array<{ role: "system" | "user" | "assistant"; content: string; eventType: string }> = [];

      // 在后台运行 Agent Loop，不阻塞流的返回
      (async () => {
        try {
          const { agent, context: existingContext } = await getOrCreateAgent(sessionId);

          // SSE 事件回调：先立即发 SSE，消息暂存到内存队列
          const onEvent = (event: AgentEvent) => {
            sendEvent(event.type, event.content);
            pendingMessages.push({
              role: "assistant",
              content: event.content,
              eventType: event.type,
            });
          };

          // 运行 Agent Loop
          const newContext = await agent.run(userMessage, onEvent, existingContext);

          // 更新上下文（用于多轮对话）
          activeAgents.set(sessionId, { agent, context: newContext });
        } catch (err: any) {
          sendEvent("error", `Agent 执行失败: ${err.message}`);
          pendingMessages.push({
            role: "system",
            content: `Agent 执行失败: ${err.message}`,
            eventType: "error",
          });
        } finally {
          clearInterval(heartbeat);
          try {
            streamController.close();
          } catch {}

          // 流结束后一次性批量写入所有消息到文件，避免并发写文件的竞态条件
          for (const msg of pendingMessages) {
            try {
              await addMessage(sessionId, msg);
            } catch {}
          }
        }
      })();

      return new Response(stream, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // 404
    return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
  } catch (err: any) {
    return Response.json(
      { error: err.message },
      { status: 500, headers: corsHeaders }
    );
  }
}
