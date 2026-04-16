import type { FC } from 'react';
import { MODEL_OPTIONS, QUICK_PROMPTS } from '../constants';
import { MessageList } from './message-list';
import { InputBar } from './input-bar';
import { ClarificationModal } from './clarification-modal';
import type { Message } from '../types';

interface ChatLayoutProps {
  onSubmit: (input: string) => Promise<void>;
  messages: Message[];
  loading: boolean;
  clarificationQuestion?: {
    reply: string;
    questions: string[];
  } | null;
  onClarificationSelect: (question: string) => Promise<void>;
  model: string;
  onModelChange: (model: string) => void;
}

export const ChatLayout: FC<ChatLayoutProps> = ({
  onSubmit,
  messages,
  loading,
  clarificationQuestion,
  onClarificationSelect,
  model,
  onModelChange,
}) => {
  const showWelcome = messages.length === 0;

  return (
    <main className="bh-main">
      <header className="bh-topbar">
        <div className="bh-model-select-wrap">
          <select
            className="bh-model-select"
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
          >
            {MODEL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <span className="bh-model-select-arrow">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
        </div>
      </header>

      <section className="bh-chat-area">
        {showWelcome ? (
          <div className="bh-welcome">
            <h1 className="bh-welcome-title">你好，我是 BrowserHand</h1>
            <p className="bh-welcome-subtitle">我可以帮你操控浏览器，完成搜索、点击、填表等任务</p>
            <div className="bh-quick-prompts">
              {QUICK_PROMPTS.map((item) => (
                <button
                  key={item}
                  className="bh-quick-prompt"
                  type="button"
                  onClick={() => void onSubmit(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <MessageList messages={messages} loading={loading} />
        )}
      </section>

      <InputBar loading={loading} onSubmit={onSubmit} />

      {clarificationQuestion && !loading && (
        <ClarificationModal
          reply={clarificationQuestion.reply}
          questions={clarificationQuestion.questions}
          onSelect={onClarificationSelect}
        />
      )}
    </main>
  );
};
