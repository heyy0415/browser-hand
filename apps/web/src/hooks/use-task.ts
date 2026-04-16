/**
 * useTask Hook
 * 管理任务流式执行状态和多会话数据
 */

import { useCallback, useMemo, useState } from 'react';
import { submitTask } from '../services/task-api';
import type { Message, SessionItem, PipelineState, ExtractedContent, StepState, RoundInfo, RunnerStepInfo, VectorGatewayInfo, StateChangeInfo } from '../types';

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
  if (event === 'state_change_detected') return 'runner';
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

          // ── 辅助：获取当前轮次 ──
          const rounds = message.rounds ?? [];

          // 确保当前轮次存在
          const ensureCurrentRound = (): RoundInfo[] => {
            if (rounds.length === 0) {
              return [{ roundIndex: 0, pipeline: { ...INITIAL_PIPELINE }, runnerSteps: [] }];
            }
            return rounds;
          };

          // 更新当前轮次的 pipeline 状态
          const updateCurrentRoundPipeline = (update: Partial<PipelineState>): RoundInfo[] => {
            const rs = ensureCurrentRound();
            return rs.map((r, i) =>
              i === rs.length - 1
                ? { ...r, pipeline: { ...r.pipeline, ...update } }
                : r,
            );
          };

          // 更新当前轮次的 runnerSteps
          const updateCurrentRoundSteps = (
            updater: (steps: RunnerStepInfo[]) => RunnerStepInfo[],
          ): RoundInfo[] => {
            const rs = ensureCurrentRound();
            return rs.map((r, i) =>
              i === rs.length - 1
                ? { ...r, runnerSteps: updater(r.runnerSteps) }
                : r,
            );
          };

          // ── Intention 层 ──
          if (event === 'intention.start') {
            return {
              ...message,
              pipeline: { ...message.pipeline ?? { ...INITIAL_PIPELINE }, intention: 'running' as StepState },
              thinking: { content: '', completed: false },
              rounds: ensureCurrentRound(),
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

          // ── Pipeline 轮次开始 ──
          if (event === 'pipeline.round-start') {
            const d = data as { roundIndex: number; totalRounds: number; completedSteps: number; totalSteps: number };
            const newRounds = [...ensureCurrentRound()];

            // 如果是新一轮（不是首轮），创建新的 round
            if (d.roundIndex > 0) {
              newRounds.push({
                roundIndex: d.roundIndex,
                pipeline: { ...INITIAL_PIPELINE },
                runnerSteps: [],
              });
            }

            return {
              ...message,
              rounds: newRounds,
              // 重置顶层 pipeline 到新轮次初始状态
              pipeline: { ...INITIAL_PIPELINE, intention: 'done' as StepState },
            };
          }

          // ── Scanner 层 ──
          if (event === 'scanner.start') {
            return {
              ...message,
              pipeline: { ...message.pipeline ?? { ...INITIAL_PIPELINE }, scanner: 'running' as StepState },
              rounds: updateCurrentRoundPipeline({ scanner: 'running' as StepState }),
            };
          }

          if (event === 'scanner.scanning') {
            return message;
          }

          if (event === 'scanner.done') {
            return {
              ...message,
              pipeline: { ...message.pipeline ?? { ...INITIAL_PIPELINE }, scanner: 'done' as StepState },
              rounds: updateCurrentRoundPipeline({ scanner: 'done' as StepState }),
            };
          }

          // ── Vector 层 ──
          if (event === 'vector.start') {
            return {
              ...message,
              pipeline: { ...message.pipeline ?? { ...INITIAL_PIPELINE }, vector: 'running' as StepState },
              rounds: updateCurrentRoundPipeline({ vector: 'running' as StepState }),
            };
          }

          if (event === 'vector.filtering' || event === 'vector.computing') {
            return message;
          }

          if (event === 'vector.gateway') {
            const d = data as { route: string; originalLines: number; filteredLines: number; compressionRatio: string };
            const gatewayInfo: VectorGatewayInfo = {
              route: d.route as VectorGatewayInfo['route'],
              originalLines: d.originalLines,
              filteredLines: d.filteredLines,
              compressionRatio: d.compressionRatio,
            };
            // 更新当前轮次的 vectorGateway
            const rs = ensureCurrentRound();
            const updatedRounds = rs.map((r, i) =>
              i === rs.length - 1 ? { ...r, vectorGateway: gatewayInfo } : r,
            );
            return {
              ...message,
              vectorGateway: gatewayInfo,
              rounds: updatedRounds,
            };
          }

          if (event === 'vector.done') {
            return {
              ...message,
              pipeline: { ...message.pipeline ?? { ...INITIAL_PIPELINE }, vector: 'done' as StepState },
              rounds: updateCurrentRoundPipeline({ vector: 'done' as StepState }),
            };
          }

          // ── Abstractor 层 ──
          if (event === 'abstractor.start') {
            return {
              ...message,
              pipeline: { ...message.pipeline ?? { ...INITIAL_PIPELINE }, abstractor: 'running' as StepState },
              rounds: updateCurrentRoundPipeline({ abstractor: 'running' as StepState }),
            };
          }

          if (event === 'abstractor.done') {
            return {
              ...message,
              pipeline: { ...message.pipeline ?? { ...INITIAL_PIPELINE }, abstractor: 'done' as StepState },
              rounds: updateCurrentRoundPipeline({ abstractor: 'done' as StepState }),
            };
          }

          // ── 状态突变（v2.0 重入核心） ──
          if (event === 'state_change_detected') {
            const d = data as { type: string; reason: string; targetUrl?: string };
            const changeInfo: StateChangeInfo = {
              reason: d.reason,
              target: d.targetUrl,
            };
            // 追加到 message.stateChanges 和当前 round
            const existingChanges = message.stateChanges ?? [];
            const rs = ensureCurrentRound();
            const updatedRounds = rs.map((r, i) => {
              if (i !== rs.length - 1) return r;
              const roundChanges = r.stateChanges ?? [];
              return { ...r, stateChanges: [...roundChanges, changeInfo] };
            });
            return {
              ...message,
              stateChanges: [...existingChanges, changeInfo],
              rounds: updatedRounds,
            };
          }

          // ── Runner 层 ──
          if (event === 'runner.start') {
            // 不再清空 runnerSteps，而是追加到当前轮次
            return {
              ...message,
              pipeline: { ...message.pipeline ?? { ...INITIAL_PIPELINE }, runner: 'running' as StepState },
              rounds: updateCurrentRoundPipeline({ runner: 'running' as StepState }),
              // 兼容：顶层 runnerSteps 指向当前轮次（用于旧的渲染逻辑）
              runnerSteps: [],
            };
          }

          if (event === 'runner.step-start') {
            const d = data as { lineNumber: number; code: string; action: string };
            const newStep: RunnerStepInfo = {
              lineNumber: d.lineNumber,
              code: d.code,
              action: d.action,
              status: 'running' as const,
            };
            const newTopSteps = [...(message.runnerSteps || []), newStep];
            return {
              ...message,
              runnerSteps: newTopSteps,
              rounds: updateCurrentRoundSteps((steps) => [...steps, newStep]),
            };
          }

          if (event === 'runner.step-done') {
            const d = data as { lineNumber: number; code: string; status: string; elapsedMs: number; screenshot?: string };
            const updateStep = (steps: RunnerStepInfo[]) =>
              steps.map((step) =>
                step.lineNumber === d.lineNumber
                  ? { ...step, status: 'success' as const, elapsedMs: d.elapsedMs, screenshot: d.screenshot, extractedScreenshot: d.screenshot }
                  : step,
              );
            return {
              ...message,
              runnerSteps: updateStep(message.runnerSteps || []),
              rounds: updateCurrentRoundSteps(updateStep),
            };
          }

          if (event === 'runner.step-error') {
            const d = data as { lineNumber: number; code: string; error: { type: string; message: string }; retrying: boolean; retryAttempt: number };
            const updateStep = (steps: RunnerStepInfo[]) =>
              steps.map((step) =>
                step.lineNumber === d.lineNumber
                  ? { ...step, status: 'failed' as const, error: d.error.message }
                  : step,
              );
            return {
              ...message,
              runnerSteps: updateStep(message.runnerSteps || []),
              rounds: updateCurrentRoundSteps(updateStep),
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

            const updateStepExtract = (steps: RunnerStepInfo[]) =>
              steps.map((step) =>
                step.lineNumber === d.lineNumber
                  ? { ...step, extractedText: d.text }
                  : step,
              );

            // 更新当前轮次的 extractedContent
            const rs = ensureCurrentRound();
            const updatedRounds = rs.map((r, i) => {
              if (i !== rs.length - 1) return r;
              const roundContent = r.extractedContent || {
                type: 'text' as const,
                textResults: [],
                screenshotResults: [],
              };
              return {
                ...r,
                runnerSteps: updateStepExtract(r.runnerSteps),
                extractedContent: {
                  ...roundContent,
                  type: roundContent.screenshotResults.length > 0 ? 'mixed' as const : 'text' as const,
                  textResults: [...roundContent.textResults, { selector: d.selector, text: d.text, lineNumber: d.lineNumber }],
                } as ExtractedContent,
              };
            });

            return {
              ...message,
              extractedContent: newContent,
              runnerSteps: updateStepExtract(message.runnerSteps || []),
              rounds: updatedRounds,
            };
          }

          if (event === 'runner.done') {
            const d = data as { success: boolean; steps: unknown[]; extractedContent?: ExtractedContent; totalElapsedMs?: number; navigationDetected?: boolean; navigatedToUrl?: string };
            return {
              ...message,
              pipeline: { ...message.pipeline ?? { ...INITIAL_PIPELINE }, runner: (d.success ? 'done' : 'error') as StepState },
              extractedContent: d.extractedContent || message.extractedContent,
              rounds: updateCurrentRoundPipeline({ runner: (d.success ? 'done' : 'error') as StepState }),
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
              rounds: layer
                ? updateCurrentRoundPipeline({ [layer]: 'error' as StepState })
                : rounds,
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
