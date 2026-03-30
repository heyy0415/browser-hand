/**
 * useTask Hook
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
