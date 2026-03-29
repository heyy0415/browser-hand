/**
 * useTask Hook for Extension
 * 管理任务流式执行状态和数据
 */

import { useState, useCallback } from 'react';
import { submitTask } from '../services/taskApi';
import type { SSEEvent, StepEventData } from '@browser-hand/engine';

export interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  steps?: StepMessage[];
}

export interface StepMessage {
  step: string;
  stepNumber: number;
  delta: unknown;
  completed: boolean;
}

const STEPS = [
  { key: 'intention', label: '意图解析', icon: '🎯' },
  { key: 'scanner', label: '页面扫描', icon: '🔍' },
  { key: 'vector', label: '向量处理', icon: '📊' },
  { key: 'abstractor', label: '动作生成', icon: '⚡' },
  { key: 'runner', label: '执行动作', icon: '🚀' },
];

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
        content: '',
        steps: STEPS.map((s, idx) => ({
          step: s.key,
          stepNumber: idx + 1,
          delta: null,
          completed: false,
        })),
      };

      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setLoading(true);

      try {
        await submitTask(userInput, {
          onEvent: (event: SSEEvent) => {
            const { event: eventType, data } = event;

            if (eventType === 'step') {
              const stepData = data as StepEventData;
              setMessages((prev) =>
                prev.map((msg): Message => {
                  if (msg.id === assistantMessage.id) {
                    const updatedSteps = msg.steps?.map((s): StepMessage => {
                      if (stepData.step === s.step) {
                        if (stepData.type === 'delta') {
                          return {
                            ...s,
                            delta: stepData.data,
                          };
                        } else {
                          return {
                            ...s,
                            delta: stepData.data,
                            completed: true,
                          };
                        }
                      }
                      return s;
                    });

                    return {
                      ...msg,
                      steps: updatedSteps,
                    };
                  }
                  return msg;
                }),
              );
            } else if (eventType === 'done') {
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantMessage.id
                    ? { ...msg, content: '✅ 任务完成！' }
                    : msg,
                ),
              );
            } else if (eventType === 'error') {
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantMessage.id
                    ? { ...msg, content: `❌ 错误: ${data.message}` }
                    : msg,
                ),
              );
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
