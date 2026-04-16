import type { FC } from "react";
import type {
  Message,
  ThinkingState,
  RunnerStepInfo,
  VectorGatewayInfo,
  StateChangeInfo,
  RoundInfo,
} from "../types";

// ═══════════════════════════════════════════════════════════════════════
// 11.1: VectorGatewaySection 组件
// ═══════════════════════════════════════════════════════════════════════

const VectorGatewaySection: FC<{ gateway: VectorGatewayInfo }> = ({ gateway }) => {
  const isPlanA = gateway.route === "PLAN_A_HARDFILTER";
  const label = isPlanA ? "极速拦截" : "语义降级";
  const desc = isPlanA
    ? `走 Plan A 硬过滤，上下文压缩 ${gateway.compressionRatio} (${gateway.originalLines}行 → ${gateway.filteredLines}行)`
    : "走 Plan B 向量检索";

  return (
    <div className="bh-gateway">
      <span className={`bh-gateway-badge ${isPlanA ? "bh-gateway-badge--a" : "bh-gateway-badge--b"}`}>
        [{label}]
      </span>
      <span className="bh-gateway-desc">{desc}</span>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════
// 11.3: 优化 ThinkingSection — 解析 thinking 中的检查清单
// ═══════════════════════════════════════════════════════════════════════

/** 尝试将 thinking 文本解析为简洁的自然语言描述 */
function parseThinkingToSummary(content: string): string[] {
  const lines: string[] = [];

  // 尝试提取 JSON 检查清单中的关键字段
  const platformMatch = content.match(/平台判定:\s*(.+)/);
  if (platformMatch) {
    lines.push(`平台: ${platformMatch[1].trim()}`);
  }

  const stepsMatch = content.match(/操作拆解:\s*(.+)/);
  if (stepsMatch) {
    lines.push(`操作: ${stepsMatch[1].trim()}`);
  }

  const positionMatch = content.match(/位置提取:\s*(.+)/);
  if (positionMatch && !positionMatch[1].includes("无")) {
    lines.push(`位置: ${positionMatch[1].trim()}`);
  }

  const contextMatch = content.match(/上下文校验:\s*(.+)/);
  if (contextMatch && !contextMatch[1].includes("跳过")) {
    lines.push(`上下文: ${contextMatch[1].trim()}`);
  }

  // 如果无法解析出结构化信息，返回原始文本的前 3 行
  if (lines.length === 0) {
    const rawLines = content.trim().split("\n").filter((l) => l.trim()).slice(0, 3);
    return rawLines;
  }

  return lines;
}

const ThinkingSection: FC<{ thinking: ThinkingState }> = ({ thinking }) => {
  if (!thinking.content.trim()) return null;

  const summaryLines = parseThinkingToSummary(thinking.content.trim());

  return (
    <div className={`bh-thinking`}>
      <div className="bh-thinking-header">
        <div className="bh-thinking-header-left">
          {!thinking.completed && (
            <span className="bh-spinner bh-spinner--sm" />
          )}
          <span className="bh-thinking-title">思考过程</span>
        </div>
      </div>
      <div className="bh-thinking-text">
        {summaryLines.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════
// Runner 执行时间线（含内联提取内容 + 11.2 重入扫描提示行）
// ═══════════════════════════════════════════════════════════════════════

const ACTION_LABELS: Record<string, string> = {
  navigate: "导航",
  open: "导航",
  fill: "填写",
  click: "点击",
  select: "选择",
  check: "勾选",
  uncheck: "取消勾选",
  scroll: "滚动",
  wait: "等待",
  extract: "提取",
  screenshot: "截图",
  getText: "提取文本",
};

function getActionLabel(code: string): string {
  const m = code.match(/^([a-zA-Z][a-zA-Z0-9]*)\(/);
  return m ? ACTION_LABELS[m[1]] || m[1] : code;
}

/** 11.2: 重入扫描提示行 */
const StateChangeHint: FC<{ changes: StateChangeInfo[] }> = ({ changes }) => {
  if (changes.length === 0) return null;
  return (
    <div className="bh-state-change-hint">
      {changes.map((change, i) => (
        <div key={i} className="bh-state-change-item">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ marginRight: 6, flexShrink: 0 }}>
            <path d="M6 1L11 6L6 11L1 6Z" stroke="currentColor" strokeWidth="1.2" fill="none" />
          </svg>
          <span>检测到页面变更: {change.reason}{change.target ? ` → ${change.target}` : ""}</span>
        </div>
      ))}
    </div>
  );
};

const RunnerTimeline: FC<{
  steps: RunnerStepInfo[];
  running: boolean;
  roundLabel?: string;
  stateChanges?: StateChangeInfo[];
}> = ({
  steps,
  running,
  roundLabel,
  stateChanges,
}) => {
  return (
    <div className="bh-timeline">
      <div className="bh-timeline-header">
        {running && (
          <span
            className="bh-spinner bh-spinner--sm"
            style={{ marginRight: 8 }}
          />
        )}
        <span className="bh-timeline-title">
          {roundLabel ? `${roundLabel}` : '任务执行'}
        </span>
      </div>
      {/* 11.2: 重入扫描提示行 */}
      {stateChanges && stateChanges.length > 0 && (
        <StateChangeHint changes={stateChanges} />
      )}
      {steps.map((step, index) => (
        <div key={step.lineNumber} className="bh-timeline-step">
          <div className="bh-timeline-rail">
            <div
              className={`bh-timeline-node bh-timeline-node--${step.status}`}
            >
              {step.status === "running" ? (
                <span className="bh-spinner bh-spinner--sm" />
              ) : step.status === "success" ? (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path
                    d="M2 5.5L4 7.5L8 3"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : step.status === "failed" ? (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path
                    d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              ) : (
                <span className="bh-timeline-skip">⊘</span>
              )}
            </div>
            {index < steps.length - 1 && <div className="bh-timeline-line" />}
          </div>
          <div className="bh-timeline-body">
            <div className="bh-timeline-code-row">
              <span className="bh-timeline-action">
                {getActionLabel(step.code)}
              </span>
              <span className="bh-timeline-code">{step.code}</span>
            </div>
            <div className="bh-timeline-meta">
              {step.status === "running" && (
                <span className="bh-timeline-running">执行中...</span>
              )}
              {step.status === "success" && step.elapsedMs != null && (
                <span className="bh-timeline-elapsed">{step.elapsedMs}ms</span>
              )}
              {step.status === "failed" && step.error && (
                <span className="bh-timeline-error">{step.error}</span>
              )}
            </div>

            {/* 内联提取内容：文本 */}
            {step.extractedText && (
              <div className="bh-timeline-extract">
                <div className="bh-timeline-extract-text">
                  {step.extractedText}
                </div>
              </div>
            )}

            {/* 内联提取内容：截图 */}
            {step.extractedScreenshot && (
              <div className="bh-timeline-extract">
                <img
                  className="bh-timeline-extract-img"
                  src={`data:image/png;base64,${step.extractedScreenshot}`}
                  alt={`step-${step.lineNumber}-screenshot`}
                />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════
// 主组件：消息列表
// ═══════════════════════════════════════════════════════════════════════

interface MessageListProps {
  messages: Message[];
  loading: boolean;
}

/** 判断 Scanner 是否已完成（用于决定 VectorGatewaySection 的显示时机） */
function isScannerDone(round: RoundInfo): boolean {
  return round.pipeline.scanner === "done" || round.pipeline.scanner === "error";
}

export const MessageList: FC<MessageListProps> = ({ messages, loading }) => (
  <div className="bh-conversation">
    {messages.map((message) =>
      message.type === "user" ? (
        <div className="bh-user-row" key={message.id}>
          <div className="bh-user-message">{message.content}</div>
        </div>
      ) : (
        <div className="bh-assistant-row" key={message.id}>
          {/* 思考过程 */}
          {message.thinking && !message.asking && (
            <ThinkingSection thinking={message.thinking} />
          )}

          {/* 多轮执行时间线 */}
          {message.rounds && message.rounds.length > 0 && !message.asking
            ? // 多轮模式：渲染每一轮（只显示已开始的轮次）
              message.rounds
                .filter((round) => round.pipeline.scanner !== "pending")
                .map((round) => (
                  <div key={`round-${round.roundIndex}`}>
                    {/* 每轮的 VectorGatewaySection */}
                    {round.vectorGateway && isScannerDone(round) && (
                      <VectorGatewaySection gateway={round.vectorGateway} />
                    )}
                    <RunnerTimeline
                      steps={round.runnerSteps}
                      running={
                        round.pipeline.runner !== "done" &&
                        round.pipeline.runner !== "error" &&
                        !message.isError &&
                        round.roundIndex === message.rounds!.length - 1
                      }
                      roundLabel={
                        message.rounds!.length > 1
                          ? `第 ${round.roundIndex + 1} 轮 · 任务执行`
                          : undefined
                      }
                      stateChanges={round.stateChanges}
                    />
                  </div>
                ))
            : // 单轮模式（向后兼容）
              message.pipeline?.scanner &&
              message.pipeline.scanner !== "pending" &&
              !message.asking && (
                <RunnerTimeline
                  steps={message.runnerSteps ?? []}
                  running={
                    message.pipeline.runner !== "done" &&
                    message.pipeline.runner !== "error" &&
                    !message.isError
                  }
                  stateChanges={message.stateChanges}
                />
              )}

          {/* 错误区域 */}
          {message.errorMessage && (
            <div className="bh-error">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <circle
                  cx="7"
                  cy="7"
                  r="6"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M7 4.5V7.5M7 9.5V9"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
              {message.errorMessage}
            </div>
          )}

          {/* 澄清问题 */}
          {message.asking && !loading && (
            <div className="bh-clarification">
              <p className="bh-clarification-text">{message.asking.reply}</p>
            </div>
          )}
        </div>
      ),
    )}
  </div>
);
