/**
 * useTask Hook
 * 管理任务流式执行状态和多会话数据
 */

import { useCallback, useMemo, useState } from 'react';
import { submitTask } from '../services/task-api';
import type { Message, SessionItem, PipelineState, ExtractedContent, StepState } from '../types';

const INITIAL_PIPELINE: PipelineState = {
  intention: 'pending',
  scanner: 'pending',
  vector: 'pending',
  abstractor: 'pending',
  runner: 'pending',
};

function createSession(initialTitle = '新会话'): SessionItem {
  const now = Date.now();
  return {
    id: `session-${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: initialTitle,
    createdAt: now,
    messages: [],
  };
}

/** 根据 SSE 事件更新某层状态 */
function getLayerFromEvent(event: string): keyof PipelineState | null {
  if (event.startsWith('intention.')) return 'intention';
  if (event.startsWith('scanner.')) return 'scanner';
  if (event.startsWith('vector.')) return 'vector';
  if (event.startsWith('abstractor.')) return 'abstractor';
  if (event.startsWith('runner.')) return 'runner';
  return null;
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
    return (sseEvent: { event: string; data: unknown }) => {
      const { event, data } = sseEvent;

      updateSession(sessionId, (session) => ({
        ...session,
        messages: session.messages.map((message) => {
          if (message.id !== assistantMessageId) {
            return message;
          }

          const layer = getLayerFromEvent(event);

          // ── Intention 层 ──
          if (event === 'intention.start') {
            return {
              ...message,
              pipeline: { ...message.pipeline ?? { ...INITIAL_PIPELINE }, intention: 'running' as StepState },
              thinking: { content: '', completed: false },
            };
          }

          if (event === 'intention.thinking') {
            const d = data as { delta: string; accumulated: string };
            return {
              ...message,
              thinking: { content: d.accumulated, completed: false },
            };
          }

          if (event === 'intention.done') {
            const d = data as { status: string; reply?: string; flow?: unknown[]; question?: string[]; elapsedMs?: number };
            const isError = d.status === 'out_of_scope';
            const newPipeline = { ...message.pipeline ?? { ...INITIAL_PIPELINE }, intention: (isError ? 'error' : 'done') as StepState };
            const newThinking = { ...message.thinking ?? { content: '', completed: false }, completed: true };

            // 处理 clarification_needed
            if (d.status === 'clarification_needed') {
              const intentionData = d as { reply: string; question: string[] };
              setClarificationQuestion({
                reply: intentionData.reply,
                questions: intentionData.question,
              });
              return {
                ...message,
                pipeline: newPipeline,
                thinking: newThinking,
                completed: true,
                asking: { reply: intentionData.reply, questions: intentionData.question },
              };
            }

            return {
              ...message,
              pipeline: newPipeline,
              thinking: newThinking,
            };
          }

          // ── Scanner 层 ──
          if (event === 'scanner.start') {
            return {
              ...message,
              pipeline: { ...message.pipeline ?? { ...INITIAL_PIPELINE }, scanner: 'running' as StepState },
            };
          }

          if (event === 'scanner.scanning') {
            // 可选：展示扫描进度，暂不修改 message
            return message;
          }

          if (event === 'scanner.done') {
            return {
              ...message,
              pipeline: { ...message.pipeline ?? { ...INITIAL_PIPELINE }, scanner: 'done' as StepState },
            };
          }

          // ── Vector 层 ──
          if (event === 'vector.start') {
            return {
              ...message,
              pipeline: { ...message.pipeline ?? { ...INITIAL_PIPELINE }, vector: 'running' as StepState },
            };
          }

          if (event === 'vector.filtering' || event === 'vector.computing') {
            // 中间进度事件，暂不修改 message
            return message;
          }

          if (event === 'vector.done') {
            return {
              ...message,
              pipeline: { ...message.pipeline ?? { ...INITIAL_PIPELINE }, vector: 'done' as StepState },
            };
          }

          // ── Abstractor 层 ──
          if (event === 'abstractor.start') {
            return {
              ...message,
              pipeline: { ...message.pipeline ?? { ...INITIAL_PIPELINE }, abstractor: 'running' as StepState },
            };
          }

          if (event === 'abstractor.done') {
            return {
              ...message,
              pipeline: { ...message.pipeline ?? { ...INITIAL_PIPELINE }, abstractor: 'done' as StepState },
            };
          }

          // ── Runner 层 ──
          if (event === 'runner.start') {
            return {
              ...message,
              pipeline: { ...message.pipeline ?? { ...INITIAL_PIPELINE }, runner: 'running' as StepState },
              runnerSteps: [],
            };
          }

          if (event === 'runner.step-start') {
            const d = data as { lineNumber: number; code: string; action: string };
            const newSteps = [...(message.runnerSteps || []), {
              lineNumber: d.lineNumber,
              code: d.code,
              action: d.action,
              status: 'running' as const,
            }];
            return {
              ...message,
              runnerSteps: newSteps,
            };
          }

          if (event === 'runner.step-done') {
            const d = data as { lineNumber: number; code: string; status: string; elapsedMs: number; screenshot?: string };
            const newSteps = (message.runnerSteps || []).map((step) =>
              step.lineNumber === d.lineNumber
                ? { ...step, status: 'success' as const, elapsedMs: d.elapsedMs, screenshot: d.screenshot, extractedScreenshot: d.screenshot }
                : step,
            );
            return {
              ...message,
              runnerSteps: newSteps,
            };
          }

          if (event === 'runner.step-error') {
            const d = data as { lineNumber: number; code: string; error: { type: string; message: string }; retrying: boolean; retryAttempt: number };
            const newSteps = (message.runnerSteps || []).map((step) =>
              step.lineNumber === d.lineNumber
                ? { ...step, status: 'failed' as const, error: d.error.message }
                : step,
            );
            return {
              ...message,
              runnerSteps: newSteps,
            };
          }

          if (event === 'runner.extract') {
            const d = data as { lineNumber: number; selector: string; text: string };
            const currentContent = message.extractedContent || {
              type: 'text' as const,
              textResults: [],
              screenshotResults: [],
            };
            const newContent: ExtractedContent = {
              ...currentContent,
              type: currentContent.screenshotResults.length > 0 ? 'mixed' : 'text',
              textResults: [...currentContent.textResults, { selector: d.selector, text: d.text, lineNumber: d.lineNumber }],
            };

            // 同时将提取内容绑定到对应 runner step 上，以便内联展示
            const newSteps = (message.runnerSteps || []).map((step) =>
              step.lineNumber === d.lineNumber
                ? { ...step, extractedText: d.text }
                : step,
            );

            return {
              ...message,
              extractedContent: newContent,
              runnerSteps: newSteps,
            };
          }

          if (event === 'runner.done') {
            const d = data as { success: boolean; steps: unknown[]; extractedContent?: ExtractedContent; totalElapsedMs?: number };
            return {
              ...message,
              pipeline: { ...message.pipeline ?? { ...INITIAL_PIPELINE }, runner: (d.success ? 'done' : 'error') as StepState },
              extractedContent: d.extractedContent || message.extractedContent,
            };
          }

          // ── 全局事件 ──
          if (event === 'task.done') {
            return { ...message, completed: true };
          }

          if (event === 'task.error') {
            const errorData = data as { step?: string; message?: string } | string;
            const errorMsg = typeof errorData === 'string'
              ? errorData
              : (errorData.message ?? String(errorData));

            const newPipeline = layer
              ? { ...message.pipeline ?? { ...INITIAL_PIPELINE }, [layer]: 'error' as StepState }
              : message.pipeline;

            return {
              ...message,
              isError: true,
              errorMessage: errorMsg,
              completed: true,
              pipeline: newPipeline,
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
        completed: false,
        pipeline: { ...INITIAL_PIPELINE },
        thinking: { content: '', completed: false },
        runnerSteps: [],
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

      // 构建对话上下文
      const context: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      for (const msg of activeSession.messages) {
        if (msg.type === 'user') {
          context.push({ role: 'user', content: msg.content ?? '' });
        }
      }

      const userMessage = createMessage('user', text);
      const assistantMessageId = createId('assistant');
      const assistantMessage: Message = {
        id: assistantMessageId,
        type: 'assistant',
        completed: false,
        pipeline: { ...INITIAL_PIPELINE },
        thinking: { content: '', completed: false },
        runnerSteps: [],
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
