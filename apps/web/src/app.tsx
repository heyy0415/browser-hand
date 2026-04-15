import type { FC } from 'react';
import { useTask } from './hooks/use-task';
import { Sidebar } from './components/sidebar';
import { ChatLayout } from './components/chat-layout';

const App: FC = () => {
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
    <div className="bh-app">
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSwitchSession={switchSession}
        onCreateSession={createNewSession}
      />
      <ChatLayout
        onSubmit={handleSubmit}
        messages={messages}
        loading={loading}
        clarificationQuestion={clarificationQuestion}
        onClarificationSelect={handleClarification}
        model={model}
        onModelChange={setModel}
      />
    </div>
  );
};

export default App;
