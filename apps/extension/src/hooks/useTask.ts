/**
 * useTask Hook for Extension
 * 管理任务流式执行状态和数据
 */

import { useState, useCallback } from 'react';
import { submitTask } from '../services/taskApi';
import type { SSEEvent } from '@browser-hand/engine';

export interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  completed?: boolean;
}

/**
 * 在当前活跃标签页中执行脚本
 * 使用 world: 'MAIN' 直接在页面上下文中执行，绕过 CSP 限制
 */
async function executeScriptInPage(script: string, retries = 3): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('无法获取当前标签页');
  }

  const tabUrl = tab.url || '';

  // 检查是否是受限的 URL
  const blocked = ['chrome://', 'chrome-extension://', 'about:', 'edge://', 'brave://', 'data:'];
  if (blocked.some(prefix => tabUrl.startsWith(prefix))) {
    console.warn('[executeScriptInPage] 无法在受限页面执行脚本:', tabUrl);
    throw new Error(`无法在受限页面执行脚本: ${tabUrl}`);
  }

  console.log('[executeScriptInPage] 开始执行脚本，tabId:', tab.id);
  console.log('[executeScriptInPage] 脚本长度:', script.length);

  try {
    // 方案 A：直接在页面的 MAIN world 中执行函数
    // 这样代码在页面 JS 上下文中运行，绕过 CSP
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',  // 关键：在页面主上下文中执行
      func: (code: string) => {
        // 直接执行代码，不需要创建 script 标签
        // 在 MAIN world 中，这等同于在页面的 JS 环境中运行
        const fn = new Function(code);
        fn();
      },
      args: [script],
    });

    console.log('[executeScriptInPage] 脚本执行完成');
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // 如果脚本太大导致序列化失败，尝试分块执行
    if (errorMsg.includes('serialize') || errorMsg.includes('size')) {
      console.warn('[executeScriptInPage] 脚本过大，尝试分块执行');
      await executeScriptInChunks(tab.id, script);
      return;
    }

    // 连接错误重试
    if (
      (errorMsg.includes('Could not establish connection') ||
        errorMsg.includes('Receiving end does not exist')) &&
      retries > 0
    ) {
      console.warn(`[executeScriptInPage] 连接失败，500ms 后重试 (剩余 ${retries} 次)...`);
      await new Promise(resolve => setTimeout(resolve, 500));
      return executeScriptInPage(script, retries - 1);
    }

    console.error('[executeScriptInPage] 执行失败:', errorMsg);
    throw err;
  }
}

/**
 * 分块执行大型脚本（避免 Chrome 消息大小限制）
 */
async function executeScriptInChunks(tabId: number, script: string): Promise<void> {
  const CHUNK_SIZE = 50000; // 每块 50KB

  for (let i = 0; i < script.length; i += CHUNK_SIZE) {
    const chunk = script.substring(i, i + CHUNK_SIZE);
    const isLastChunk = i + CHUNK_SIZE >= script.length;

    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (code: string) => {
        const fn = new Function(code);
        fn();
      },
      args: [chunk],
    });

    console.log(
      `[executeScriptInPage] 分块执行: ${Math.min(i + CHUNK_SIZE, script.length)}/${script.length}`,
    );

    // 块之间稍作等待
    if (!isLastChunk) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}


export function useTask() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(
    async (userInput: string) => {
      const userMessage: Message = {
        id: Date.now().toString(),
        type: 'user',
        content: userInput,
      };

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        type: 'assistant',
        content: ''
      };

      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setLoading(true);

      try {
        await submitTask(userInput, {
          onEvent: (event: SSEEvent) => {
            const { event: eventType, data } = event;
            const streamData = data as any
            setMessages((prev) =>
              prev.map((msg): any => {
                if (msg.type === "assistant") {
                  return {
                    ...msg,
                    content: eventType === 'delta'
                      ? msg.content += streamData :
                      eventType === 'delta_done'
                        ? streamData
                        : eventType === 'completed' ? JSON.stringify(JSON.parse(streamData), null, 2) : '',
                    completed: eventType === 'completed' ? true : false
                  };
                }
                return msg;
              }),
            );
            if (eventType === 'done') {
              executeScriptInPage(streamData)
            }
          },
          onError: (error: Error) => {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantMessage.id
                  ? { ...msg, content: `❌ ${error.message}` }
                  : msg,
              ),
            );
          },
          onComplete: () => {
            setLoading(false);
          },
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : '未知错误';
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessage.id
              ? { ...msg, content: `❌ ${errorMessage}` }
              : msg,
          ),
        );
        setLoading(false);
      }
    },
    [],
  );

  return { messages, loading, handleSubmit };
}

