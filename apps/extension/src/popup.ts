import React from 'react';
import ReactDOM from 'react-dom/client';
import { Chat } from '@browser-hand/ui';
import { useTask } from './hooks/useTask';

function App() {
  const { messages, loading, handleSubmit } = useTask();

  return React.createElement(Chat, { onSubmit: handleSubmit, messages, loading });
}

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  React.createElement(
    React.StrictMode,
    null,
    React.createElement(App)
  )
);
