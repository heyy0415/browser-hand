/**
 * 对话面板 - 展示流式消息和输入框，截图内联展示，提取内容用 Table 展示
 */

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Table } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useSSE, type SSEMessage } from "../hooks/useSSE";

interface ChatPanelProps {
  sessionId: string | null;
}

const API_BASE = "/api";

/** 截图放大弹窗 */
function ScreenshotModal({
  src,
  onClose,
}: {
  src: string;
  onClose: () => void;
}) {
  return (
    <div className="screenshot-modal-overlay" onClick={onClose}>
      <div className="screenshot-modal" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt="浏览器截图" />
        <button className="screenshot-modal-close" onClick={onClose}>
          x
        </button>
      </div>
    </div>
  );
}

/** 从 action 消息内容中提取 done 动作的 text 参数（如果是 done 动作的话） */
function tryExtractDoneText(actionContent: string): string | null {
  const match = actionContent.match(/^done\((\{[\s\S]*\})\)$/);
  if (!match) return null;
  try {
    const params = JSON.parse(match[1]);
    return params.text || null;
  } catch {}
  return null;
}

/** 尝试解析 JSON 数组，用于 Table 展示 */
function tryParseJsonArray(content: any): Record<string, any>[] | null {
  try {
    if (
      Array.isArray(content) &&
      content.length > 0 &&
      typeof content[0] === "object"
    ) {
      return content;
    }
    if (typeof content === "string") {
      const parsed = JSON.parse(content);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        typeof parsed[0] === "object"
      ) {
        return parsed;
      }
    }
  } catch {}
  return null;
}

/** 从数据数组自动生成 antd Table 列定义 */
function buildColumns(
  data: Record<string, any>[],
): ColumnsType<Record<string, any>> {
  const keys = Object.keys(data[0]);
  return keys.map((key) => ({
    title: key,
    dataIndex: key,
    key,
    ellipsis: true,
    width: Math.max(120, Math.min(300, key.length * 20)),
  }));
}

/** 单条消息的渲染 */
function MessageBubble({
  msg,
  onScreenshotClick,
}: {
  msg: SSEMessage;
  onScreenshotClick?: (data: string) => void;
}) {
  const typeLabels: Record<string, { label: string; className: string }> = {
    thinking: { label: "思考", className: "msg-thinking" },
    action: { label: "动作", className: "msg-action" },
    observation: { label: "观察", className: "msg-observation" },
    done: { label: "完成", className: "msg-done" },
    error: { label: "错误", className: "msg-error" },
    user: { label: "", className: "msg-user" },
  };

  // 截图消息：渲染为内联小图
  if (msg.type === "screenshot") {
    return (
      <div className="msg-screenshot-inline">
        <img
          src={`data:image/jpeg;base64,${msg.content}`}
          alt="浏览器截图"
          className="screenshot-thumb"
          onClick={() => onScreenshotClick?.(msg.content)}
        />
      </div>
    );
  }

  const info = typeLabels[msg.type] || {
    label: msg.type,
    className: "msg-default",
  };

  // done 消息：静默，仅显示完成标记，不展示内容
  if (msg.type === "done") {
    return (
      <div className="msg-bubble msg-done msg-done-silent">
        <span className="msg-label">{info.label}</span>
        <span className="msg-content">任务已完成</span>
      </div>
    );
  }

  // action 消息：检测 done 动作中的提取数据，用 Table 展示
  if (msg.type === "action" && typeof msg.content === "string") {
    const doneText = tryExtractDoneText(msg.content);
    if (doneText) {
      const tableData = tryParseJsonArray(doneText);
      if (tableData) {
        const columns = buildColumns(tableData);
        return (
          <div className="msg-bubble msg-done">
            <span className="msg-label">提取结果</span>
            <div className="msg-extract-table">
              <Table
                columns={columns}
                dataSource={tableData.map((row, i) => ({ ...row, _key: i }))}
                rowKey="_key"
                size="small"
                virtual
                pagination={tableData.length > 10 ? { pageSize: 10 } : false}
                scroll={{ x: "max-content", y: 400 }}
              />
            </div>
          </div>
        );
      }
      // done 动作但非结构化数据，显示普通文本
      return (
        <div className="msg-bubble msg-done">
          <span className="msg-label">{info.label}</span>
          <span className="msg-content">{doneText}</span>
        </div>
      );
    }
  }

  return (
    <div className={`msg-bubble ${info.className}`}>
      {info.label && <span className="msg-label">{info.label}</span>}
      <span className="msg-content">
        {typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content)}
      </span>
    </div>
  );
}

export function ChatPanel({ sessionId }: ChatPanelProps) {
  const [input, setInput] = useState("");
  const [historyMessages, setHistoryMessages] = useState<SSEMessage[]>([]);
  const [modalScreenshot, setModalScreenshot] = useState<string | null>(null);
  const {
    messages: streamMessages,
    isStreaming,
    startStream,
    clearMessages,
  } = useSSE();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 加载历史消息
  useEffect(() => {
    if (!sessionId) {
      setHistoryMessages([]);
      clearMessages();
      return;
    }

    fetch(`${API_BASE}/sessions/${sessionId}`)
      .then((res) => res.json())
      .then((session) => {
        if (session?.messages) {
          const msgs: SSEMessage[] = session.messages
            .filter((m: any) => m.role !== "system")
            .map((m: any) => ({
              type: m.eventType || (m.role === "user" ? "user" : "thinking"),
              content: m.content,
            }));
          setHistoryMessages(msgs);
        }
      })
      .catch(() => setHistoryMessages([]));
    clearMessages();
  }, [sessionId]);

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [streamMessages, historyMessages]);

  const handleSend = async () => {
    if (!input.trim() || !sessionId || isStreaming) return;

    const userMsg = input.trim();
    setInput("");

    setHistoryMessages((prev) => [...prev, { type: "user", content: userMsg }]);
    startStream(sessionId, userMsg);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleScreenshotClick = useCallback((data: string) => {
    setModalScreenshot(data);
  }, []);

  const allMessages = [...historyMessages, ...streamMessages];

  if (!sessionId) {
    return (
      <div className="chat-panel chat-empty">
        <p>选择一个会话或创建新会话开始</p>
      </div>
    );
  }

  return (
    <div className="chat-panel">
      <div className="chat-messages">
        {allMessages.map((msg, i) => (
          <MessageBubble
            key={i}
            msg={msg}
            onScreenshotClick={handleScreenshotClick}
          />
        ))}
        {isStreaming && (
          <div className="streaming-indicator">Agent 运行中...</div>
        )}
        <div ref={messagesEndRef} />
      </div>
      <div className="chat-input-area">
        <div className="chat-input-box">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入指令控制浏览器..."
            rows={1}
            disabled={isStreaming}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isStreaming}
            className="btn-send"
          >
            发送
          </button>
        </div>
      </div>
      {modalScreenshot && (
        <ScreenshotModal
          src={`data:image/jpeg;base64,${modalScreenshot}`}
          onClose={() => setModalScreenshot(null)}
        />
      )}
    </div>
  );
}
