import React, { useState, useRef, useEffect } from 'react';
import loadingGif from '../static/loading.gif';
import './index.css';

export interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  completed?: boolean;
}

export interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  completed?: boolean;
}

interface ChatProps {
  onSubmit: (input: string) => Promise<void>;
  messages: Message[];
  loading: boolean;
}

export const Chat: React.FC<ChatProps> = ({ onSubmit, messages, loading }) => {
  const [input, setInput] = useState('帮我打开百度，搜索什么是计算机科学');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userInput = input;
    setInput('');
    await onSubmit(userInput);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!loading && input.trim()) {
        handleSubmit(e as any);
      }
    }
  };

  return (
    <div className="chat-container">
      <div className="chat-messages-area">
        {messages.length === 0 ? (
          <div className="chat-empty-state">
            <div className="chat-welcome">
              <h2 className="chat-welcome-title">BrowserHand</h2>
              <p className="chat-welcome-subtitle">向我提出你的诉求</p>
              <div className="chat-suggestions">
                <p className="chat-suggestions-label">常见问题</p>
                <div className="chat-suggestions-list">
                  {[
                    '帮我打开百度，搜索什么是计算机科学',
                    '在当前页面向下滚动300px，再向上滚动100px',
                    '帮我获取当前这个页面所有的文本内容',
                  ].map((item, idx) => (
                    <div
                      key={idx}
                      className="chat-suggestion-item"
                      onClick={() => setInput(item)}
                    >
                      {item}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <>
            {messages.map((message) => (
              <div
                key={message.id}
                className={`chat-message-wrapper ${message.type === 'user' ? 'chat-message-user' : 'chat-message-assistant'}`}
              >
                {message.type === 'user' ? (
                  <div className="chat-user-bubble">
                    <p className="chat-user-text">{message.content}</p>
                  </div>
                ) : (
                  <div className="chat-assistant-content">
                    {message.content && (
                      <div className="chat-assistant-message">
                        {!message.completed && (<img src={loadingGif} alt="loading" />)}
                        <p className="chat-assistant-text">{message.content}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input Form */}
      <div className="chat-input-area">
        <form onSubmit={handleSubmit} className="chat-input-form">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Send a message..."
            disabled={loading}
            rows={4}
            className="chat-input-field"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="chat-send-button"
          >
            {loading ? (
              <div className="chat-send-spinner" />
            ) : (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                width="16"
                height="16"
              >
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            )}
          </button>
        </form>
      </div>
    </div>
  );
};

export default Chat;
