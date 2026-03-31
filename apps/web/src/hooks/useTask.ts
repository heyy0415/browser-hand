/**
 * useTask Hook
 * 管理任务流式执行状态和多会话数据
 */

import { useCallback, useMemo, useState } from 'react';
import { submitTask } from '../services/taskApi';
import type { SSEEvent } from '@browser-hand/engine';

export interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  completed?: boolean;
}

export interface SessionItem {
  id: string;
  title: string;
  createdAt: number;
  messages: Message[];
}

function createSession(initialTitle = '新会话'): SessionItem {
  const now = Date.now();
  return {
    id: `session-${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: initialTitle,
    createdAt: now,
    messages: [],
  };
}

function buildDeltaText(data: unknown): string {
  if (typeof data === 'string') {
    return data;
  }
  if (data === null || data === undefined) {
    return '';
  }
  if (typeof data === 'object') {
    const candidate = data as Record<string, unknown>;
    if (typeof candidate.content === 'string') {
      return candidate.content;
    }
    if (typeof candidate.text === 'string') {
      return candidate.text;
    }
    return JSON.stringify(data);
  }
  return String(data);
}

function buildCompletedText(data: unknown): string {
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return data;
    }
  }
  return JSON.stringify(data, null, 2);
}

export function useTask() {
  const [sessions, setSessions] = useState<SessionItem[]>([createSession()]);
  const [activeSessionId, setActiveSessionId] = useState<string>(sessions[0].id);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);

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

  const handleSubmit = useCallback(
    async (question: string) => {
      const text = question.trim();
      if (!text || !activeSession) {
        return;
      }

      if (loadingSessionId) {
        return;
      }

      const userMessage: Message = {
        id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: 'user',
        content: text,
        completed: true,
      };

      const assistantMessageId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const assistantMessage: Message = {
        id: assistantMessageId,
        type: 'assistant',
        content: '',
        completed: false,
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
          onEvent: (event: SSEEvent) => {
            updateSession(activeSession.id, (session) => ({
              ...session,
              messages: session.messages.map((message) => {
                if (message.id !== assistantMessageId) {
                  return message;
                }

                if (event.event === 'delta') {
                  return {
                    ...message,
                    content: `${message.content}${buildDeltaText(event.data)}`,
                  };
                }

                if (event.event === 'delta_done') {
                  return {
                    ...message,
                    content: buildDeltaText(event.data) || message.content,
                  };
                }

                if (event.event === 'completed' || event.event === 'done') {
                  return {
                    ...message,
                    content: buildCompletedText(event.data) || message.content,
                    completed: true,
                  };
                }

                if (event.event === 'error') {
                  return {
                    ...message,
                    content: `error:${buildDeltaText(event.data)}`,
                    completed: true,
                  };
                }

                return message;
              }),
            }));
          },
          onError: (error: Error) => {
            updateSession(activeSession.id, (session) => ({
              ...session,
              messages: session.messages.map((message) =>
                message.id === assistantMessageId
                  ? { ...message, content: `error:${error.message}`, completed: true }
                  : message,
              ),
            }));
            setLoadingSessionId(null);
          },
          onComplete: () => {
            updateSession(activeSession.id, (session) => ({
              ...session,
              messages: session.messages.map((message) =>
                message.id === assistantMessageId ? { ...message, completed: true } : message,
              ),
            }));
            setLoadingSessionId(null);
          },
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '未知错误';
        updateSession(activeSession.id, (session) => ({
          ...session,
          messages: session.messages.map((message) =>
            message.id === assistantMessageId
              ? { ...message, content: `error:${errorMessage}`, completed: true }
              : message,
          ),
        }));
        setLoadingSessionId(null);
      }
    },
    [activeSession, loadingSessionId, updateSession],
  );

  return {
    sessions,
    activeSessionId,
    messages: activeSession?.messages ?? [],
    loading: loadingSessionId === activeSessionId,
    createNewSession,
    switchSession,
    handleSubmit,
  };
}
