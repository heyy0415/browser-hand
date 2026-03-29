import React from 'react';
import ReactDOM from 'react-dom/client';
import { Chat } from '@browser-hand/ui';
import { useTask } from './hooks/useTask';
import '../../../packages/ui/src/styles/index.css';

function App() {
  const { messages, loading, handleSubmit } = useTask();

  return <Chat onSubmit={handleSubmit} messages={messages} loading={loading} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
