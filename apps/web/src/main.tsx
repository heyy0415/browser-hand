import React from 'react';
import ReactDOM from 'react-dom/client';
import { Chat } from './components/Chat';
import { useTask } from './hooks/useTask';

function App() {
  const {
    sessions,
    activeSessionId,
    messages,
    loading,
    clarificationQuestion,
    model,
    setModel,
    createNewSession,
    switchSession,
    handleSubmit,
    handleClarification,
  } = useTask();

  return (
    <Chat
      activeSessionId={activeSessionId}
      loading={loading}
      messages={messages}
      clarificationQuestion={clarificationQuestion}
      model={model}
      onClarificationSelect={handleClarification}
      onModelChange={setModel}
      onCreateSession={createNewSession}
      onSubmit={handleSubmit}
      onSwitchSession={switchSession}
      sessions={sessions}
    />
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
