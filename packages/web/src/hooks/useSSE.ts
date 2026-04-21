/**
 * SSE 流式消息 Hook
 * 
 * 封装 fetch + ReadableStream 读取 SSE 事件
 * 注意：SSE 连接必须绕过 Vite 代理，直连后端，否则 Vite 代理会 hang up 长连接
 */

import { useState, useCallback, useRef } from "react";

export interface SSEMessage {
  type: string;     // thinking / action / observation / screenshot / done / error / end
  content: any;     // 可能是 string，也可能是 JSON 解析后的 object/array
}

/** 后端直连地址（SSE 必须绕过 Vite 代理） */
const BACKEND_URL = "http://localhost:3001";

export function useSSE() {
  const [messages, setMessages] = useState<SSEMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const startStream = useCallback((sessionId: string, userMessage: string) => {
    // 中止已有连接
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const abortController = new AbortController();
    abortRef.current = abortController;

    setIsStreaming(true);
    const newMessages: SSEMessage[] = [];

    // SSE 必须直连后端，绕过 Vite 代理
    // Vite 的 http-proxy 对 SSE 长连接支持不佳，会导致 socket hang up
    const url = `${BACKEND_URL}/api/sessions/${sessionId}/chat`;

    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: userMessage }),
      signal: abortController.signal,
    })
      .then(async (response) => {
        if (!response.ok || !response.body) {
          throw new Error(`请求失败: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // 解析 SSE 格式：event: xxx\ndata: "xxx"\n\n
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            if (!part.trim()) continue;
            let eventType = "message";
            let data = "";
            for (const line of part.split("\n")) {
              if (line.startsWith("event: ")) {
                eventType = line.slice(7);
              } else if (line.startsWith("data: ")) {
                try {
                  data = JSON.parse(line.slice(6));
                } catch {
                  data = line.slice(6);
                }
              }
            }

            if (eventType === "done") {
              setIsStreaming(false);
              return;
            }

            const msg: SSEMessage = { type: eventType, content: data };
            newMessages.push(msg);
            setMessages([...newMessages]);
          }
        }

        setIsStreaming(false);
      })
      .catch((err) => {
        if (err.name === "AbortError") return; // 主动中止，不报错
        const errorMsg: SSEMessage = { type: "error", content: `连接失败: ${err.message}` };
        newMessages.push(errorMsg);
        setMessages([...newMessages]);
        setIsStreaming(false);
      });
  }, []);

  const stopStream = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsStreaming(false);
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return { messages, isStreaming, startStream, stopStream, clearMessages };
}
