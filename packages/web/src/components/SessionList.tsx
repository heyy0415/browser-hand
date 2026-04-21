/**
 * 会话列表面板
 */

import { useState, useEffect } from "react";

interface SessionItem {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

interface SessionListProps {
  currentSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
}

const API_BASE = "/api";

export function SessionList({ currentSessionId, onSelectSession, onNewSession }: SessionListProps) {
  const [sessions, setSessions] = useState<SessionItem[]>([]);

  const fetchSessions = async () => {
    try {
      const res = await fetch(`${API_BASE}/sessions`);
      const data = await res.json();
      setSessions(Array.isArray(data) ? data : []);
    } catch {}
  };

  useEffect(() => {
    fetchSessions();
  }, []);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch(`${API_BASE}/sessions/${id}`, { method: "DELETE" });
    fetchSessions();
    if (currentSessionId === id) {
      onNewSession();
    }
  };

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  return (
    <div className="session-list">
      <div className="session-list-header">
        <h2>BrowserHand</h2>
        <button className="btn-new" onClick={() => { onNewSession(); fetchSessions(); }}>
          + 新会话
        </button>
      </div>
      <div className="session-list-items">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`session-item ${currentSessionId === s.id ? "active" : ""}`}
            onClick={() => onSelectSession(s.id)}
          >
            <div className="session-item-title">{s.title}</div>
            <div className="session-item-meta">
              <span>{formatDate(s.updatedAt)}</span>
              <button
                className="btn-delete"
                onClick={(e) => handleDelete(s.id, e)}
              >
                x
              </button>
            </div>
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="session-empty">暂无会话</div>
        )}
      </div>
    </div>
  );
}
