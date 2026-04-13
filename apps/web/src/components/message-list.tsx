import { useState, useEffect, useRef } from 'react';
import type { FC } from 'react';
import { STEP_LABELS, STEP_ICONS } from '../constants';
import type { Message, PipelineState, ThinkingState, RunnerStepInfo, ExtractedContent } from '../types';
import loadingGif from '../static/loading.gif';

// ═══════════════════════════════════════════════════════════════════════
// 子组件：Pipeline 状态指示器
// ═══════════════════════════════════════════════════════════════════════

const PipelineStatusBar: FC<{ pipeline: PipelineState }> = ({ pipeline }) => {
  const layers: Array<{ key: keyof PipelineState; label: string; icon: string }> = [
    { key: 'intention', label: STEP_LABELS.intention, icon: STEP_ICONS.intention },
    { key: 'scanner', label: STEP_LABELS.scanner, icon: STEP_ICONS.scanner },
    { key: 'vector', label: STEP_LABELS.vector, icon: STEP_ICONS.vector },
    { key: 'abstractor', label: STEP_LABELS.abstractor, icon: STEP_ICONS.abstractor },
    { key: 'runner', label: STEP_LABELS.runner, icon: STEP_ICONS.runner },
  ];

  return (
    <div className="b-handpipeline-bar">
      {layers.map((layer, i) => (
        <div key={layer.key} className="b-handpipeline-step">
          <div className={`b-handpipeline-node is-${pipeline[layer.key]}`}>
            {pipeline[layer.key] === 'running' ? (
              <span className="b-handpipeline-spinner" />
            ) : pipeline[layer.key] === 'done' ? (
              <span className="b-handpipeline-check">&#10003;</span>
            ) : pipeline[layer.key] === 'error' ? (
              <span className="b-handpipeline-cross">&#10007;</span>
            ) : (
              <span className="b-handpipeline-dot" />
            )}
          </div>
          <span className="b-handpipeline-label">{layer.icon} {layer.label}</span>
          {i < layers.length - 1 && <div className="b-handpipeline-connector" />}
        </div>
      ))}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════
// 子组件：思考过程面板
// ═══════════════════════════════════════════════════════════════════════

const ThinkingSection: FC<{ thinking: ThinkingState }> = ({ thinking }) => {
  const [collapsed, setCollapsed] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 思考完成后自动折叠
    if (thinking.completed && thinking.content) {
      const timer = setTimeout(() => setCollapsed(true), 1500);
      return () => clearTimeout(timer);
    }
  }, [thinking.completed]);

  if (!thinking.content.trim()) return null;

  return (
    <div className={`b-handthinking ${collapsed ? 'is-collapsed' : ''}`}>
      <div
        className="b-handthinking-header"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="b-handthinking-title">思考过程</span>
        <span className="b-handthinking-toggle">{collapsed ? '▶' : '▼'}</span>
      </div>
      {!collapsed && (
        <div className="b-handthinking-content" ref={contentRef}>
          {!thinking.completed && (
            <img src={loadingGif} alt="thinking" className="b-handthinking-loading" />
          )}
          <span className="b-handthinking-text">{thinking.content}</span>
        </div>
      )}
      {collapsed && (
        <div className="b-handthinking-summary">
          {thinking.content.slice(0, 60)}...
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════
// 子组件：Runner 执行时间线
// ═══════════════════════════════════════════════════════════════════════

const RunnerTimeline: FC<{ steps: RunnerStepInfo[] }> = ({ steps }) => {
  if (steps.length === 0) return null;

  return (
    <div className="b-handtimeline">
      {steps.map((step, index) => (
        <div key={step.lineNumber} className="b-handtimeline-step">
          <div className="b-handtimeline-rail">
            <div className={`b-handtimeline-node is-${step.status}`}>
              {step.status === 'running' ? (
                <span className="b-handtimeline-spinner" />
              ) : step.status === 'success' ? (
                <span className="b-handtimeline-check">&#10003;</span>
              ) : (
                <span className="b-handtimeline-cross">&#10007;</span>
              )}
            </div>
            {index < steps.length - 1 && <div className="b-handtimeline-line" />}
          </div>
          <div className="b-handtimeline-body">
            <div className="b-handtimeline-code">{step.code}</div>
            <div className="b-handtimeline-meta">
              {step.status === 'running' && <span className="b-handtimeline-running">执行中...</span>}
              {step.status === 'success' && step.elapsedMs != null && (
                <span className="b-handtimeline-elapsed">{step.elapsedMs}ms</span>
              )}
              {step.status === 'failed' && step.error && (
                <span className="b-handtimeline-error">{step.error}</span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════
// 子组件：提取内容展示
// ═══════════════════════════════════════════════════════════════════════

const ExtractedContentSection: FC<{ content: ExtractedContent }> = ({ content }) => {
  if (content.textResults.length === 0 && content.screenshotResults.length === 0) {
    return null;
  }

  return (
    <div className="b-handextracted">
      <div className="b-handextracted-header">提取结果</div>
      {content.textResults.map((result, i) => (
        <div key={i} className="b-handextracted-text">
          <div className="b-handextracted-selector">{result.selector}</div>
          <div className="b-handextracted-value">{result.text}</div>
        </div>
      ))}
      {content.screenshotResults.map((screenshot, i) => (
        <div key={i} className="b-handextracted-screenshot">
          <img src={`data:image/png;base64,${screenshot}`} alt={`screenshot-${i}`} />
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
  <div className="b-handconversation">
    {messages.map((message) =>
      message.type === 'user' ? (
        <div className="b-handuser-row" key={message.id}>
          <div className="b-handuser-message">{message.content}</div>
        </div>
      ) : (
        <div className="b-handassistant-row" key={message.id}>
          {/* Pipeline 状态指示器 */}
          {message.pipeline && <PipelineStatusBar pipeline={message.pipeline} />}

          {/* 思考过程 */}
          {message.thinking && !message.asking && (
            <ThinkingSection thinking={message.thinking} />
          )}

          {/* Runner 执行时间线 */}
          {message.runnerSteps && message.runnerSteps.length > 0 && !message.asking && (
            <RunnerTimeline steps={message.runnerSteps} />
          )}

          {/* 提取内容 */}
          {message.extractedContent && !message.asking && (
            <ExtractedContentSection content={message.extractedContent} />
          )}

          {/* 错误区域 */}
          {message.errorMessage && (
            <div className="b-handerror-area">
              {message.errorMessage}
            </div>
          )}

          {/* 澄清问题 */}
          {message.asking && !loading && (
            <div className="b-handclarification-options">
              <p className="b-handclarification-text">{message.asking.reply}</p>
            </div>
          )}
        </div>
      ),
    )}
  </div>
);
