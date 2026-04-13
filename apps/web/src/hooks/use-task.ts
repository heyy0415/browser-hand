/**
 * useTask Hook
 * 管理任务流式执行状态和多会话数据
 */

import { useCallback, useMemo, useState } from 'react';
import { submitTask } from '../services/task-api';
import type { SSEEvent } from '@browser-hand/core';
import type { Message, SessionItem } from '../types';

function createSession(initialTitle = '新会话'): SessionItem {
  const now = Date.now();
  return {
    id: `session-${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: initialTitle,
    createdAt: now,
    messages: [],
  };
}

export function useTask() {
  const [sessions, setSessions] = useState<SessionItem[]>([createSession()]);
  const [activeSessionId, setActiveSessionId] = useState<string>(sessions[0].id);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [clarificationQuestion, setClarificationQuestion] = useState<{
    reply: string;
    questions: string[];
  } | null>(null);
  const [model, setModel] = useState('qwen-flash');

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? sessions[0],
    [activeSessionId, sessions],
  );

  const updateSession = useCallback((sessionId: string, updater: (session: SessionItem) => SessionItem) => {
    setSessions((prev) =>
      prev.map((session) => (session.id === sessionId ? updater(session) : session)),
    );
  }, []);

  const createNewSession = useCallback(() => {
    const newSession = createSession();
    setSessions((prev) => [newSession, ...prev]);
    setActiveSessionId(newSession.id);
  }, []);

  const switchSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
  }, []);

  /** 构建事件处理 onEvent 回调 */
  function buildOnEvent(assistantMessageId: string, sessionId: string) {
    return (event: SSEEvent) => {
      updateSession(sessionId, (session) => ({
        ...session,
        messages: session.messages.map((message) => {
          if (message.id !== assistantMessageId) {
            return message;
          }

          // ── 思考区：仅 intention 和 abstractor 的 delta ──
          if (event.event === 'conversation_delta' || event.event === 'conversation_delta_completed') {
            const data = event.data as { step: string; data: string };
            if (typeof data.data !== 'string') {
              return message;
            }
            if (data.step !== 'intention' && data.step !== 'abstractor') {
              return message;
            }
            return {
              ...message,
              content: event.event === 'conversation_delta'
                ? `${message.content}${data.data}`
                : data.data || message.content,
            };
          }

          // ── 结果区：各层 completed 数据 ──
          if (event.event === 'conversation_completed') {
            const data = event.data as { step: string; status: string; data: unknown };

            if (data.step === 'intention' && data.status === 'clarification_needed') {
              const intentionData = data.data as { reply: string; question: string[] };
              setClarificationQuestion({
                reply: intentionData.reply,
                questions: intentionData.question,
              });
              return {
                ...message,
                completed: true,
                asking: { reply: intentionData.reply, questions: intentionData.question },
              };
            }

            return {
              ...message,
              completed: true,
              results: [...(message.results || []), { step: data.step, status: data.status, data: data.data }],
            };
          }

          // ── conversation_done ──
          if (event.event === 'conversation_done') {
            return { ...message, completed: true };
          }

          // ── 错误区 ──
          if (event.event === 'error') {
            const errorData = event.data as { step?: string; data?: string } | string;
            const errorMsg = typeof errorData === 'string'
              ? errorData
              : (errorData.data ?? String(errorData));
            return {
              ...message,
              isError: true,
              errorMessage: errorMsg,
              completed: true,
            };
          }

          return message;
        }),
      }));
    };
  }

  const handleSubmit = useCallback(
    async (question: string) => {
      const text = question.trim();
      if (!text || !activeSession || loadingSessionId) {
        return;
      }

      const userMessage = createMessage('user', text);
      const assistantMessageId = createId('assistant');
      const assistantMessage: Message = {
        id: assistantMessageId,
        type: 'assistant',
        content: '',
        completed: false,
        results: [],
      };

      updateSession(activeSession.id, (session) => ({
        ...session,
        title: session.messages.length === 0 ? text.slice(0, 28) : session.title,
        messages: [...session.messages, userMessage, assistantMessage],
      }));

      setLoadingSessionId(activeSession.id);

      try {
        await submitTask(text, {
          headless: false,
          sessionId: activeSession.id,
          model,
          onEvent: buildOnEvent(assistantMessageId, activeSession.id),
          onError: (error) => {
            updateSession(activeSession.id, (session) => ({
              ...session,
              messages: session.messages.map((m) =>
                m.id === assistantMessageId
                  ? { ...m, errorMessage: error.message, isError: true, completed: true }
                  : m,
              ),
            }));
            setLoadingSessionId(null);
          },
          onComplete: () => {
            updateSession(activeSession.id, (session) => ({
              ...session,
              messages: session.messages.map((m) =>
                m.id === assistantMessageId ? { ...m, completed: true } : m,
              ),
            }));
            setLoadingSessionId(null);
          },
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '未知错误';
        updateSession(activeSession.id, (session) => ({
          ...session,
          messages: session.messages.map((m) =>
            m.id === assistantMessageId
              ? { ...m, errorMessage: errorMessage, isError: true, completed: true }
              : m,
          ),
        }));
        setLoadingSessionId(null);
      }
    },
    [activeSession, loadingSessionId, updateSession, model],
  );

  const handleClarification = useCallback(
    async (selection: string) => {
      if (!clarificationQuestion || !activeSession || loadingSessionId) {
        return;
      }

      const text = selection.trim();
      if (!text) {
        return;
      }

      // 构建对话上下文：从当前会话的历史消息中提取用户提问
      const context: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      for (const msg of activeSession.messages) {
        if (msg.type === 'user') {
          context.push({ role: 'user', content: msg.content });
        }
      }

      const userMessage = createMessage('user', text);
      const assistantMessageId = createId('assistant');
      const assistantMessage: Message = {
        id: assistantMessageId,
        type: 'assistant',
        content: '',
        completed: false,
        results: [],
      };

      updateSession(activeSession.id, (session) => ({
        ...session,
        messages: [...session.messages, userMessage, assistantMessage],
      }));

      setClarificationQuestion(null);
      setLoadingSessionId(activeSession.id);

      try {
        await submitTask(text, {
          headless: false,
          sessionId: activeSession.id,
          context: context.length > 0 ? context : undefined,
          model,
          onEvent: buildOnEvent(assistantMessageId, activeSession.id),
          onError: (error) => {
            updateSession(activeSession.id, (session) => ({
              ...session,
              messages: session.messages.map((m) =>
                m.id === assistantMessageId
                  ? { ...m, errorMessage: error.message, isError: true, completed: true }
                  : m,
              ),
            }));
            setLoadingSessionId(null);
          },
          onComplete: () => {
            updateSession(activeSession.id, (session) => ({
              ...session,
              messages: session.messages.map((m) =>
                m.id === assistantMessageId ? { ...m, completed: true } : m,
              ),
            }));
            setLoadingSessionId(null);
          },
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '未知错误';
        updateSession(activeSession.id, (session) => ({
          ...session,
          messages: session.messages.map((m) =>
            m.id === assistantMessageId
              ? { ...m, errorMessage: errorMessage, isError: true, completed: true }
              : m,
          ),
        }));
        setLoadingSessionId(null);
      }
    },
    [clarificationQuestion, activeSession, loadingSessionId, updateSession, model],
  );

  return {
    sessions,
    activeSessionId,
    messages: activeSession?.messages ?? [],
    loading: loadingSessionId === activeSessionId,
    clarificationQuestion,
    model,
    setModel,
    createNewSession,
    switchSession,
    handleSubmit,
    handleClarification,
  };
}

// ── 内部工具函数 ─────────────────────────────────────────────────

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function createMessage(type: 'user' | 'assistant', content: string): Message {
  return {
    id: createId(type),
    type,
    content,
    completed: true,
  };
}
