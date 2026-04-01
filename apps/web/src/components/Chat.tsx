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
  isError?: boolean;
  errorMessage?: string;
  asking?: {
    reply: string;
    questions: string[];
  };
  results?: Array<{ step: string; status: string; data: unknown }>;
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
  clarificationQuestion?: {
    reply: string;
    questions: string[];
  } | null;
  onClarificationSelect: (question: string) => Promise<void>;
  sessions: ChatSession[];
  activeSessionId: string;
  onSwitchSession: (sessionId: string) => void;
  onCreateSession: () => void;
  model: string;
  onModelChange: (model: string) => void;
}

const MODEL_OPTIONS = [
  { value: 'qwen-flash', label: 'qwen-flash' },
  { value: 'qwen-plus', label: 'qwen-plus' },
  { value: 'qwen-max', label: 'qwen-max' },
] as const;

const QUICK_PROMPTS = [
  '帮我去淘宝搜索一个iphone 15',
  '帮我去搜索一个iphone 15',
  '帮我打开百度，获取第一条热搜内容。',
  '当前页面向下滚动300px，向上滚动100px。',
  '帮我打开百度，输入什么是计算机科学，然后点击百度一下。',
  '帮我解释一下什么是人工智能'
];

function formatHistoryTitle(title: string): string {
  if (title.length <= 18) {
    return title;
  }
  return `${title.slice(0, 18)}...`;
}

const STEP_LABELS: Record<string, string> = {
  intention: '意图解析',
  scanner: '页面扫描',
  vector: '向量分析',
  abstractor: '操作规划',
  runner: '执行操作',
};

function formatJSON(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

export const Chat: FC<ChatProps> = ({
  onSubmit,
  messages,
  loading,
  clarificationQuestion,
  onClarificationSelect,
  sessions,
  activeSessionId,
  onSwitchSession,
  onCreateSession,
  model,
  onModelChange,
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
                      <div className="b-handassistant-status">正在处理中...</div>
                    )}
                    {/* clarification_needed 仅展示弹窗 */}
                    {!message.asking && (
                      <>
                        {/* 区域1：思考区 - intention/abstractor 的推理过程 */}
                        <div className="b-handassistant-content">
                          {!message.completed && message.content ? (
                            <img src={loadingGif} alt="loading" className="b-handassistant-loading" />
                          ) : null}
                          {message.content.trim() && (
                            <div className="b-handassistant-text">
                              {message.content.trim()}
                            </div>
                          )}
                        </div>

                        {/* 区域2：结果区 - vector/abstractor/runner 的执行结果 */}
                        {message.results && message.results.length > 0 && (
                          <div className="b-handresults-area">
                            {message.results.map((result) => (
                              <div key={result.step} className="b-handresult-block">
                                <div className="b-handresult-header">
                                  <span className="b-handresult-label">{STEP_LABELS[result.step] || result.step}</span>
                                  <span className={`b-handresult-status ${result.status === 'success' ? 'is-success' : 'is-error'}`}>
                                    {result.status}
                                  </span>
                                </div>
                                <pre className="b-handresult-json">{formatJSON(result.data)}</pre>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* 区域3：错误区 */}
                        {message.errorMessage && (
                          <div className="b-handerror-area">
                            {message.errorMessage}
                          </div>
                        )}
                      </>
                    )}
                    {message.asking && !loading && (
                      <div className="b-handclarification-options">
                        <p className="b-handclarification-text">{message.asking.reply}</p>
                      </div>
                    )}
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

        {/* 全局澄清问题弹窗 */}
        {clarificationQuestion && !loading && (
          <div className="b-handclarification-modal-overlay">
            <div className="b-handclarification-modal">
              <p className="b-handclarification-modal-text">{clarificationQuestion.reply}</p>
              <div className="b-handclarification-modal-buttons">
                {clarificationQuestion.questions.map((question, index) => (
                  <button
                    key={index}
                    className="b-handclarification-modal-button"
                    type="button"
                    onClick={() => void onClarificationSelect(question)}
                  >
                    {question}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default Chat;
