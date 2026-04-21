/**
 * 上下文管理器 - 管理发送给 LLM 的消息列表
 * 
 * 借鉴自 browser-use agent/message_manager/service.py - MessageManager 类
 * browser-use 的 MessageManager 维护完整的消息历史，包括：
 * - 系统提示
 * - 用户任务
 * - 浏览器状态消息（每步替换，而非追加，避免上下文无限膨胀）
 * - LLM 响应和动作执行结果
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ActionResult } from "./actions";
import type { Action } from "./actions";
import { formatBrowserStateText, type DOMState } from "./dom";

export class ContextManager {
  private messages: ChatCompletionMessageParam[] = [];
  /** 浏览器状态消息的插入位置标记 */
  private stateMessageIndex: number = -1;

  constructor(systemPrompt: string) {
    this.messages = [{ role: "system", content: systemPrompt }];
  }

  /** 添加用户消息 */
  addUserMessage(content: string): void {
    this.messages.push({ role: "user", content });
  }

  /**
   * 添加/更新浏览器状态消息
   * 
   * 借鉴自 browser-use MessageManager 的状态消息管理策略：
   * browser-use 每步将新的浏览器状态替换旧的状态消息，而非不断追加
   * 这样可以避免上下文随步数线性增长
   */
  updateStateMessage(domState: DOMState): void {
    const stateText = formatBrowserStateText(domState);
    const stateMessage: ChatCompletionMessageParam = {
      role: "user",
      content: `[Current browser state]:\n${stateText}`,
    };

    if (this.stateMessageIndex >= 0 && this.stateMessageIndex < this.messages.length) {
      // 替换已有的状态消息（借鉴 browser-use 的替换策略）
      this.messages[this.stateMessageIndex] = stateMessage;
    } else {
      // 首次添加状态消息
      this.messages.push(stateMessage);
      this.stateMessageIndex = this.messages.length - 1;
    }
  }

  /** 添加 LLM 助手回复 */
  addAssistantMessage(content: string): void {
    this.messages.push({ role: "assistant", content });
  }

  /**
   * 添加动作执行结果
   * 
   * 借鉴自 browser-use agent/service.py 的 _post_process() 方法
   * browser-use 在动作执行后，将结果追加到消息列表供下一轮 LLM 参考
   */
  addActionResults(actions: Action[], results: ActionResult[]): void {
    const parts: string[] = [];
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const result = results[i];
      const status = result.success ? "SUCCESS" : "FAILED";
      parts.push(
        `Action: ${action.name}(${JSON.stringify(action.params)}) -> ${status}: ${result.summary}`
      );
    }
    this.messages.push({
      role: "user",
      content: `[Action execution results]:\n${parts.join("\n")}`,
    });

    // 状态消息位置需要更新（因为新增了消息）
    this.stateMessageIndex = -1;
  }

  /** 获取所有消息 */
  getMessages(): ChatCompletionMessageParam[] {
    return this.messages;
  }

  /** 获取消息数量 */
  get messageCount(): number {
    return this.messages.length;
  }

  /**
   * 截断过长的消息历史
   * 
   * 借鉴自 browser-use 的消息截断策略
   * 当消息过多时，保留 system prompt + 最近的对话轮次
   */
  trimMessages(maxMessages = 30): void {
    if (this.messages.length <= maxMessages) return;
    // 始终保留 system prompt（第一条）
    const systemMsg = this.messages[0];
    const recent = this.messages.slice(-(maxMessages - 1));
    this.messages = [systemMsg, ...recent];
    this.stateMessageIndex = -1;
  }
}
