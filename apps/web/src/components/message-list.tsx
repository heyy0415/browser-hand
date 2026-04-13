import type { FC } from 'react';
import { STEP_LABELS } from '../constants';
import type { Message } from '../types';
import loadingGif from '../static/loading.gif';

function formatJSON(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

interface MessageListProps {
  messages: Message[];
  loading: boolean;
}

export const MessageList: FC<MessageListProps> = ({ messages, loading }) => (
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
  </div>
);
