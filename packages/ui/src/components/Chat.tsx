import React, { useState, useRef, useEffect } from 'react';
import './index.css';

export interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  steps?: StepMessage[];
}

export interface StepMessage {
  step: string;
  stepNumber: number;
  delta: unknown;
  completed: boolean;
}

interface ChatProps {
  onSubmit: (input: string) => Promise<void>;
  messages: Message[];
  loading: boolean;
}

const steps = [
  { key: 'intention', label: '意图解析', icon: '🎯' },
  { key: 'scanner', label: '页面扫描', icon: '🔍' },
  { key: 'vector', label: '向量处理', icon: '📊' },
  { key: 'abstractor', label: '动作生成', icon: '⚡' },
  { key: 'runner', label: '执行动作', icon: '🚀' },
];

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
    <div className="flex flex-col h-screen bg-white">
      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center max-w-md">
              <h2 className="text-2xl font-bold text-slate-900 mb-2">BrowserHand</h2>
              <p className="text-sm text-slate-500 mb-6">向我提出你的诉求</p>
              <div className="text-left space-y-2 mb-6">
                <p className="text-xs text-slate-500 font-medium">常见问题</p>
                <div className="space-y-2">
                  {[
                    '帮我打开百度，搜索什么是计算机科学',
                    '在当前页面向下滚动300px，再向上滚动100px',
                    '帮我获取当前这个页面所有的文本内容',
                  ].map((item, idx) => (
                    <div
                      key={idx}
                      className="p-3 bg-slate-50 rounded-lg text-slate-700 text-sm hover:bg-slate-100 cursor-pointer transition-all"
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
                className={`flex ${message.type === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {message.type === 'user' ? (
                  <div className="max-w-xs lg:max-w-md bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-2xl rounded-tr-none px-4 py-3 shadow-md">
                    <p className="text-sm leading-relaxed">{message.content}</p>
                  </div>
                ) : (
                  <div className="max-w-2xl w-full space-y-4">
                    {/* Steps Container */}
                    {message.steps && message.steps.length > 0 && (
                      <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200">
                        <div className="space-y-3">
                          {steps.map((stepInfo) => {
                            const stepStatus = message.steps?.find(
                              (s) => s.step === stepInfo.key,
                            );

                            return (
                              <div
                                key={stepInfo.key}
                                className={`flex items-center gap-3 p-3 rounded-lg transition-all ${stepStatus?.completed
                                  ? 'bg-green-50 border border-green-200'
                                  : stepStatus?.delta
                                    ? 'bg-blue-50 border border-blue-200'
                                    : 'bg-slate-50 border border-slate-200'
                                  }`}
                              >
                                {/* Icon */}
                                <span className="text-xl flex-shrink-0">{stepInfo.icon}</span>

                                {/* Label */}
                                <span className="font-medium text-slate-900 flex-1">
                                  {stepInfo.label}
                                </span>

                                {/* Status */}
                                <div className="flex items-center gap-2">
                                  {stepStatus?.completed ? (
                                    <>
                                      <span className="text-xs font-semibold text-green-600">
                                        完成
                                      </span>
                                      <span className="text-green-600">✓</span>
                                    </>
                                  ) : stepStatus?.delta ? (
                                    <>
                                      <span className="text-xs font-semibold text-blue-600">
                                        执行中
                                      </span>
                                      <div className="flex gap-1">
                                        <div className="w-1.5 h-1.5 bg-blue-600 rounded-full animate-bounce" />
                                        <div className="w-1.5 h-1.5 bg-blue-600 rounded-full animate-bounce delay-100" />
                                        <div className="w-1.5 h-1.5 bg-blue-600 rounded-full animate-bounce delay-200" />
                                      </div>
                                    </>
                                  ) : (
                                    <>
                                      <span className="text-xs font-semibold text-slate-500">
                                        等待中
                                      </span>
                                      <span className="text-slate-400">○</span>
                                    </>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Content */}
                    {message.content && (
                      <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200">
                        <p className="text-slate-700 text-sm leading-relaxed">{message.content}</p>
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
      <div className="bg-white px-6 py-4 flex justify-center">
        <form onSubmit={handleSubmit} className="w-70 relative">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Shift + Enter 换行，Enter提交。"
            disabled={loading}
            rows={4}
            className="w-full px-4 py-3 pr-16 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none disabled:bg-slate-100 disabled:text-slate-500 transition-all text-sm"
          />
          <div
            type="submit"
            disabled={loading || !input.trim()}
            className="absolute bottom-2 right-2 w-8 h-8 bg-black text-white rounded-full hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center flex-shrink-0"
          >
            {loading ? (
              <div className="w-3 h-3 border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg t="1774787419874" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="5338" width="16" height="16"><path d="M931.392 11.264L45.12 530.688c-28.736 16.896-43.52 39.424-45.12 61.248v8.128c2.048 26.112 23.04 49.984 61.632 60.416l171.968 46.592a34.304 34.304 0 0 0 41.28-25.536 35.584 35.584 0 0 0-23.808-43.136L79.68 592l873.408-511.872-95.232 703.488c-1.408 10.432-9.152 15.68-18.752 12.992l-365.632-100.288 296.32-305.856a36.416 36.416 0 0 0 0-50.24 33.728 33.728 0 0 0-48.704 0l-324.8 335.36a110.72 110.72 0 0 0-7.872 9.088 35.52 35.52 0 0 0-16.128 30.784 104 104 0 0 0-5.248 32.64v206.4c0 49.664 53.568 79.168 93.568 51.712l166.272-114.368c10.24-6.976 16-19.136 15.232-31.872a35.712 35.712 0 0 0-19.2-29.504 33.28 33.28 0 0 0-34.24 2.304L435.84 937.856v-178.432l385.472 105.6c49.6 13.632 97.472-19.072 104.576-71.808l97.152-717.568c8.448-60.48-40-94.72-91.648-64.384z" fill="#ffffff" p-id="5339"></path></svg>
            )}
          </div>
        </form>
      </div>
    </div>
  );
};

export default Chat;
