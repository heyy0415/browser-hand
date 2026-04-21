import { useState } from "react";
import { SessionList } from "./components/SessionList";
import { ChatPanel } from "./components/ChatPanel";
import "./App.css";

const API_BASE = "/api";

export default function App() {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  const handleNewSession = async () => {
    try {
      const res = await fetch(`${API_BASE}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const session = await res.json();
      setCurrentSessionId(session.id);
    } catch {}
  };

  const handleSelectSession = (id: string) => {
    setCurrentSessionId(id);
  };

  return (
    <div className="app">
      <aside className="app-sidebar">
        <SessionList
          currentSessionId={currentSessionId}
          onSelectSession={handleSelectSession}
          onNewSession={handleNewSession}
        />
      </aside>
      <main className="app-main">
        <ChatPanel sessionId={currentSessionId} />
      </main>
    </div>
  );
}
