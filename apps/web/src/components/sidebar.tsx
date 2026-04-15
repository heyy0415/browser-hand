import type { FC } from "react";
import type { SessionItem } from "../types";

interface SidebarProps {
  sessions: SessionItem[];
  activeSessionId: string;
  onSwitchSession: (sessionId: string) => void;
  onCreateSession: () => void;
}

export const Sidebar: FC<SidebarProps> = ({
  sessions,
  activeSessionId,
  onSwitchSession,
  onCreateSession,
}) => (
  <aside className="bh-sidebar">
    <div className="bh-sidebar-brand">
      <span className="bh-sidebar-brand-text">BrowserHand</span>
    </div>

    <button className="bh-sidebar-new" type="button" onClick={onCreateSession}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path
          d="M7 2V12M2 7H12"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      新建对话
    </button>

    <div className="bh-sidebar-divider" />

    <div className="bh-sidebar-history-label">历史记录</div>
    <div className="bh-sidebar-history">
      {sessions.map((item) => (
        <button
          className={`bh-sidebar-history-item ${item.id === activeSessionId ? "is-active" : ""}`}
          key={item.id}
          onClick={() => onSwitchSession(item.id)}
          type="button"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            className="bh-sidebar-history-icon"
          >
            <path
              d="M2 3h10M2 7h10M2 11h7"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
          <span className="bh-sidebar-history-text">{item?.title.trim() || "新会话"}</span>
        </button>
      ))}
    </div>
  </aside>
);
