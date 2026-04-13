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
    <main className="b-handmain">
      <header className="b-handtopbar">
        <select
          className="b-handmodel-select"
          value={model}
          onChange={(e) => onModelChange(e.target.value)}
        >
          {MODEL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </header>

      <section className="b-handchat-area">
        {showWelcome ? (
          <div className="b-handwelcome">
            <p className="b-handwelcome-subtitle">
              准备好探索无限可能
            </p>
            <div className="b-handquick-prompts">
              {QUICK_PROMPTS.map((item) => (
                <button
                  key={item}
                  className="b-handprompt"
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

      {/* 全局澄清问题弹窗 */}
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
