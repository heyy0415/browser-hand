import type { FC } from 'react';
import type { SessionItem } from '../types';

interface SidebarProps {
  sessions: SessionItem[];
  activeSessionId: string;
  onSwitchSession: (sessionId: string) => void;
  onCreateSession: () => void;
}

function formatHistoryTitle(title: string): string {
  if (title.length <= 18) {
    return title;
  }
  return `${title.slice(0, 18)}...`;
}

export const Sidebar: FC<SidebarProps> = ({
  sessions,
  activeSessionId,
  onSwitchSession,
  onCreateSession,
}) => (
  <aside className="b-handsidebar">
    <div className="b-handbrand-row">
      <div className="b-handbrand">BrowserHand</div>
      <button className="b-handnew-chat" onClick={onCreateSession} type="button">
        ＋
      </button>
    </div>

    <nav className="b-handnav-list">
      <button className="b-handnav-item b-handnav-item-active" type="button">
        开始聊天
      </button>
    </nav>

    <div className="b-handhistory-title">历史记录</div>
    <div className="b-handhistory-list">
      {sessions.map((item) => (
        <button
          className={`b-handhistory-item ${item.id === activeSessionId ? 'is-active' : ''}`}
          key={item.id}
          onClick={() => onSwitchSession(item.id)}
          type="button"
        >
          {formatHistoryTitle(item.title)}
        </button>
      ))}
    </div>
  </aside>
);
