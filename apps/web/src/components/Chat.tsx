import {
  useEffect,
  useRef,
  useState,
  type FC,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import loadingGif from '../static/loading.gif';
import './index.css';

export interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  completed?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  messages: Message[];
}

interface ChatProps {
  onSubmit: (input: string) => Promise<void>;
  messages: Message[];
  loading: boolean;
  sessions: ChatSession[];
  activeSessionId: string;
  onSwitchSession: (sessionId: string) => void;
  onCreateSession: () => void;
}

const QUICK_PROMPTS = [
  '帮我打开百度，获取全部热搜内容。',
  '帮我打开百度，获取第一条热搜内容。',
  '当前页面向下滚动300px，向上滚动100px。',
  '帮我打开百度，输入什么是计算机科学，然后点击百度一下。',
];

function formatHistoryTitle(title: string): string {
  if (title.length <= 18) {
    return title;
  }
  return `${title.slice(0, 18)}...`;
}

export const Chat: FC<ChatProps> = ({
  onSubmit,
  messages,
  loading,
  sessions,
  activeSessionId,
  onSwitchSession,
  onCreateSession,
}) => {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!input.trim() || loading) {
      return;
    }

    const question = input;
    setInput('');
    await onSubmit(question);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!loading && input.trim()) {
        void onSubmit(input.trim());
        setInput('');
      }
    }
  };

  const showWelcome = messages.length === 0;

  return (
    <div className="b-handapp">
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

      <main className="b-handmain">
        <header className="b-handtopbar">
          <button className="b-handmodel" type="button">
            b-handV2-Pro
          </button>
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
                    onClick={() => setInput(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="b-handconversation">
              {messages.map((message) =>
                message.type === 'user' ? (
                  <div className="b-handuser-row" key={message.id}>
                    <div className="b-handuser-message">{message.content}</div>
                  </div>
                ) : (
                  <div className="b-handassistant-row" key={message.id}>
                    {loading && !message.completed && (
                      <div className="b-handassistant-status">已深度思考（用时 11 秒）</div>
                    )}
                    <div className="b-handassistant-content">
                      {!message.completed && message.content ? (
                        <img src={loadingGif} alt="loading" className="b-handassistant-loading" />
                      ) : null}
                      <div className="b-handassistant-text">{message.content}</div>
                    </div>
                  </div>
                ),
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </section>

        <footer className="b-handinput-wrap">
          <form className="b-handinput-form" onSubmit={handleSubmit}>
            <textarea
              className="b-handinput"
              disabled={loading}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Shift + Enter 换行，Enter发送。"
              rows={2}
              value={input}
            />
            <button className="b-handsend" disabled={loading || !input.trim()} type="submit">
              ↗
            </button>
          </form>
          <div className="b-handdisclaimer">本回答由 BrowserHand 团队生成并提供参考</div>
        </footer>
      </main>
    </div>
  );
};

export default Chat;
