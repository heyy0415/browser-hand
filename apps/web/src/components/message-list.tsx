import type { FC } from "react";
import type {
  Message,
  ThinkingState,
  RunnerStepInfo,
  ExtractedContent,
} from "../types";

// ═══════════════════════════════════════════════════════════════════════
// 子组件：思考过程面板
// ═══════════════════════════════════════════════════════════════════════

const ThinkingSection: FC<{ thinking: ThinkingState }> = ({ thinking }) => {
  if (!thinking.content.trim()) return null;

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
      {<div className="bh-thinking-text">{thinking.content.trim()}</div>}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════
// 子组件：Runner 执行时间线（含内联提取内容）
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

const RunnerTimeline: FC<{ steps: RunnerStepInfo[]; running: boolean }> = ({
  steps,
  running,
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
        <span className="bh-timeline-title">任务执行</span>
      </div>
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
                <div className="bh-timeline-extract-label">提取内容</div>
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
// 子组件：提取内容汇总展示
// ═══════════════════════════════════════════════════════════════════════

const ExtractedContentSection: FC<{ content: ExtractedContent }> = ({
  content,
}) => {
  if (
    content.textResults.length === 0 &&
    content.screenshotResults.length === 0
  ) {
    return null;
  }

  return (
    <div className="bh-extracted">
      <div className="bh-extracted-header">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path
            d="M2 3h10M2 7h10M2 11h7"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        提取结果
      </div>
      {content.textResults.map((result, i) => (
        <div key={i} className="bh-extracted-item">
          <div className="bh-extracted-selector">{result.selector}</div>
          <div className="bh-extracted-value">{result.text}</div>
        </div>
      ))}
      {content.screenshotResults.map((screenshot, i) => (
        <div key={`ss-${i}`} className="bh-extracted-screenshot">
          <img
            src={`data:image/png;base64,${screenshot}`}
            alt={`screenshot-${i}`}
          />
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
          {/* Runner 执行时间线 */}
          {message.pipeline?.scanner &&
            message.pipeline.scanner !== 'pending' &&
            !message.asking && (
              <RunnerTimeline
                steps={message.runnerSteps ?? []}
                running={
                  message.pipeline.runner !== 'done' &&
                  message.pipeline.runner !== 'error' &&
                  !message.isError
                }
              />
            )}

          {/* 提取内容汇总（仅当没有内联提取时显示，或作为兜底） */}
          {message.extractedContent &&
            message.extractedContent.textResults.length > 0 &&
            !message.asking && (
              <ExtractedContentSection content={message.extractedContent} />
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
