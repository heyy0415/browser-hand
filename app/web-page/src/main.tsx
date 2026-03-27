import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import '../styles.css';

interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  steps?: StepStatus[];
}

interface StepStatus {
  step: string;
  stepNumber: number;
  status: 'pending' | 'running' | 'completed' | 'error';
  message?: string;
  data?: unknown;
}

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  const steps = [
    { key: 'intention', label: '意图解析', icon: '🎯' },
    { key: 'scanner', label: '页面扫描', icon: '🔍' },
    { key: 'vector', label: '向量处理', icon: '📊' },
    { key: 'abstractor', label: '动作生成', icon: '⚡' },
    { key: 'runner', label: '执行动作', icon: '🚀' },
  ];

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      type: 'user',
      content: input,
    };

    const assistantMessage: Message = {
      id: (Date.now() + 1).toString(),
      type: 'assistant',
      content: '',
      steps: steps.map((s) => ({
        step: s.key,
        stepNumber: steps.indexOf(s) + 1,
        status: 'pending' as const,
      })),
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput('');
    setLoading(true);

    try {
      const response = await fetch('/api/task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userInput: input }),
      });

      if (!response.ok) throw new Error('请求失败');

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) throw new Error('无法读取响应流');

      let currentEvent = 'chunk';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        console.log('Raw SSE chunk:', chunk); // 调试原始数据
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
            continue;
          }
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (!data) continue;

            try {
              const parsed = JSON.parse(data);
              // 添加事件类型到解析的数据中
              const eventData = { ...parsed, event: currentEvent };

              // 调试：打印收到的消息
              console.log('SSE Event:', currentEvent, eventData);

              setMessages((prev) =>
                prev.map((msg): Message => {
                  if (msg.id === assistantMessage.id) {
                    const updatedSteps = msg.steps?.map((s): StepStatus => {
                      // 处理 step_start 事件：设置步骤为运行中
                      if (currentEvent === 'step_start' && eventData.stepNumber === s.stepNumber) {
                        return { ...s, status: 'running' as const };
                      }
                      // 处理 step_complete 事件：设置步骤为完成
                      if (eventData.step === s.step) {
                        return {
                          ...s,
                          status: 'completed',
                          data: eventData.data,
                        } as StepStatus;
                      }
                      // 如果某个步骤完成，标记之前的步骤为完成
                      if (eventData.stepNumber && s.stepNumber === eventData.stepNumber - 1) {
                        return { ...s, status: 'completed' as const };
                      }
                      // 如果某个步骤开始，标记之前的步骤为完成
                      if (eventData.stepNumber && s.stepNumber === eventData.stepNumber - 1 && currentEvent === 'step_start') {
                        return { ...s, status: 'completed' as const };
                      }
                      return s;
                    });

                    let updatedContent = msg.content;
                    if (currentEvent === 'action') {
                      updatedContent += `\n执行: ${eventData.code}\n`;
                    } else if (currentEvent === 'done' && eventData.success) {
                      updatedContent += '\n✅ 任务完成！';
                    } else if (currentEvent === 'error') {
                      updatedContent += `\n❌ 错误: ${eventData.message}`;
                    }

                    return {
                      ...msg,
                      content: updatedContent,
                      steps: updatedSteps,
                    } as Message;
                  }
                  return msg;
                }),
              );
            } catch {
              // 忽略解析错误
            }
          }
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : '未知错误';

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessage.id
            ? { ...msg, content: `❌ ${errorMessage}` }
            : msg,
        ),
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="chat-container">
      <header className="chat-header">
        <h1>🤖 Browser Hand</h1>
        <p>智能浏览器自动化助手</p>
      </header>

      <div className="messages-container">
        {messages.map((message) => (
          <div key={message.id} className={`message ${message.type}`}>
            {message.type === 'user' ? (
              <div className="message-bubble user">{message.content}</div>
            ) : (
              <div className="message-bubble assistant">
                {message.steps && (
                  <div className="steps-container">
                    {steps.map((stepInfo) => {
                      const stepStatus =
                        message.steps?.find((s) => s.step === stepInfo.key) ||
                        ({
                          status: 'pending' as const,
                        } as StepStatus);

                      return (
                        <div
                          key={stepInfo.key}
                          className={`step-item ${stepStatus.status}`}
                        >
                          <span className="step-icon">{stepInfo.icon}</span>
                          <span className="step-label">{stepInfo.label}</span>
                          <span className="step-status">
                            {stepStatus.status === 'pending' && '⏳ 等待中'}
                            {stepStatus.status === 'running' && '🔄 执行中'}
                            {stepStatus.status === 'completed' && '✅ 完成'}
                            {stepStatus.status === 'error' && '❌ 错误'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {message.content && (
                  <pre className="message-content">{message.content}</pre>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <form className="input-form" onSubmit={handleSubmit}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="输入你的指令，例如：帮我打开百度搜索..."
          disabled={loading}
          className="input-field"
        />
        <button type="submit" disabled={loading || !input.trim()} className="send-button">
          {loading ? '执行中...' : '发送'}
        </button>
      </form>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
