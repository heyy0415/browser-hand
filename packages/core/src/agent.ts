/**
 * Agent Loop 主逻辑
 * 
 * 借鉴自 browser-use agent/service.py 的 Agent 类核心循环
 * browser-use 的循环流程：run() -> while loop -> _execute_step() -> step()
 * step() 三阶段：_prepare_context() -> _get_next_action() -> _execute_actions()
 */

import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { BrowserController, type BrowserState } from "./browser";
import { ContextManager } from "./context";
import { buildSystemPrompt } from "./prompts";
import { executeAction, type Action, type ActionResult } from "./actions";
import { type DOMState } from "./dom";

/** SSE 事件类型 */
export interface AgentEvent {
  type: "thinking" | "action" | "observation" | "screenshot" | "done" | "error";
  content: string;
}

/** Agent 事件回调 */
export type AgentEventCallback = (event: AgentEvent) => void;

/** LLM 输出的结构化响应 - 借鉴自 browser-use agent/views.py 的 AgentOutput */
interface AgentOutput {
  thinking: string;
  evaluation_previous_goal: string;
  next_goal: string;
  action: Action[];
}

/** Agent 配置 */
export interface AgentConfig {
  maxSteps?: number;
  maxFailures?: number;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  cdpPort?: number;
}

const DEFAULT_CONFIG: Required<AgentConfig> = {
  maxSteps: 30,
  maxFailures: 5,
  model: "qwen-plus",
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey: process.env.OPENAI_API_KEY || "sk-3696886102834bbb99ca1773b25edd1e",
  cdpPort: 9222,
};

export class Agent {
  private browser: BrowserController;
  private config: Required<AgentConfig>;
  private openai: OpenAI;
  private consecutiveFailures = 0;

  constructor(config: AgentConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.browser = new BrowserController(this.config.cdpPort);
    this.openai = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL,
    });
  }

  /** 获取浏览器控制器实例（用于会话保持） */
  get browserController(): BrowserController {
    return this.browser;
  }

  /** 启动浏览器 */
  async start(): Promise<void> {
    await this.browser.start();
  }

  /** 关闭浏览器 */
  async stop(): Promise<void> {
    await this.browser.stop();
  }

  /**
   * 执行 Agent Loop - 核心方法
   * 
   * 借鉴自 browser-use agent/service.py 的 run() 方法
   * browser-use 的循环：while n_steps <= max_steps -> _execute_step() -> break if done
   * 
   * @param task 用户任务描述
   * @param onEvent SSE 事件回调
   * @param existingContext 已有的上下文（多轮对话复用）
   */
  async run(
    task: string,
    onEvent: AgentEventCallback,
    existingContext?: ContextManager,
  ): Promise<ContextManager> {
    // 初始化上下文管理器
    // 借鉴自 browser-use 的 MessageManager 初始化：系统提示 + 用户任务
    const context = existingContext || new ContextManager(buildSystemPrompt());

    // 如果是新上下文，添加用户任务
    if (!existingContext) {
      context.addUserMessage(`[Task]: ${task}`);
    } else {
      // 多轮对话：添加新的用户指令
      context.addUserMessage(`[New instruction]: ${task}`);
    }

    // 主循环 - 借鉴自 browser-use agent/service.py 的 while self.state.n_steps <= max_steps
    for (let step = 0; step < this.config.maxSteps; step++) {
      // 检查连续失败次数 - 借鉴自 browser-use 的 consecutive_failures 检查
      if (this.consecutiveFailures >= this.config.maxFailures) {
        onEvent({ type: "error", content: `连续 ${this.consecutiveFailures} 次失败，停止执行` });
        break;
      }

      try {
        const isDone = await this._executeStep(context, onEvent, step);
        if (isDone) break;
      } catch (err: any) {
        this.consecutiveFailures++;
        onEvent({ type: "error", content: `步骤 ${step + 1} 执行异常: ${err.message}` });
      }
    }

    return context;
  }

  /**
   * 执行单步 - 三阶段：准备上下文 → LLM 决策 → 执行动作
   * 
   * 借鉴自 browser-use agent/service.py 的 step() 方法
   * browser-use 的 step() 包含三个阶段：
   *   Phase 0: _prepare_context() - 获取浏览器状态，构建消息
   *   Phase 1: _get_next_action() - 调用 LLM 获取下一步动作
   *   Phase 2: _execute_actions() - 执行动作
   */
  private async _executeStep(
    context: ContextManager,
    onEvent: AgentEventCallback,
    stepNumber: number,
  ): Promise<boolean> {
    // === 阶段 1: 准备上下文 ===
    // 借鉴自 browser-use 的 _prepare_context() - 获取浏览器状态并更新到消息列表
    const browserState = await this.browser.getState();
    context.updateStateMessage(browserState.domState);
    context.trimMessages();

    // 推送截图
    if (browserState.screenshot) {
      onEvent({ type: "screenshot", content: browserState.screenshot });
    }

    // === 阶段 2: LLM 决策 ===
    // 借鉴自 browser-use 的 _get_next_action() - 调用 LLM 获取下一步动作
    onEvent({ type: "thinking", content: `步骤 ${stepNumber + 1}: 分析页面状态，决定下一步...` });

    const agentOutput = await this._callLLM(context.getMessages());

    // 推送 LLM 思考过程
    onEvent({ type: "thinking", content: agentOutput.thinking });
    if (agentOutput.evaluation_previous_goal) {
      onEvent({ type: "observation", content: `上一步评价: ${agentOutput.evaluation_previous_goal}` });
    }
    if (agentOutput.next_goal) {
      onEvent({ type: "thinking", content: `目标: ${agentOutput.next_goal}` });
    }

    // 将 LLM 回复加入上下文
    context.addAssistantMessage(JSON.stringify(agentOutput));

    // === 阶段 3: 执行动作 ===
    // 借鉴自 browser-use 的 _execute_actions() 和 multi_act()
    const actions = agentOutput.action;
    const results: ActionResult[] = [];

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      onEvent({ type: "action", content: `${action.name}(${JSON.stringify(action.params)})` });

      // 检查是否为 done 动作
      if (action.name === "done") {
        onEvent({ type: "done", content: "" });
        results.push({ success: true, summary: action.params.text || "任务完成" });
        context.addActionResults(actions.slice(0, i + 1), results);
        return true; // 任务完成
      }

      // 执行动作
      const result = await executeAction(action, this.browser, browserState.domState);
      results.push(result);

      onEvent({ type: "observation", content: result.summary });

      // 动作执行失败处理 - 借鉴自 browser-use 的 consecutive_failures 机制
      if (!result.success) {
        this.consecutiveFailures++;
      } else {
        this.consecutiveFailures = 0;
      }

      // 页面可能已变化（如导航），后续动作基于旧 DOM 可能失效
      // 借鉴自 browser-use 的 multi_act() 中的页面变化检测
      // 当 URL 或焦点改变时，browser-use 会中断后续动作执行
      if (["navigate", "click", "go_back"].includes(action.name) && result.success) {
        // 页面可能已改变，中断后续动作执行，等待下一步重新获取 DOM 状态
        if (i < actions.length - 1) {
          onEvent({ type: "observation", content: "页面已变化，跳过剩余动作，将重新获取页面状态" });
          break;
        }
      }
    }

    // 将动作执行结果加入上下文
    context.addActionResults(actions, results);

    return false; // 任务未完成
  }

  /**
   * 调用 LLM 获取下一步动作
   * 
   * 借鉴自 browser-use agent/service.py 的 _get_model_output_with_retry()
   * browser-use 通过 structured output 让 LLM 返回 AgentOutput 格式
   * 我们通过 prompt 约束 + JSON 解析实现
   */
  private async _callLLM(messages: ChatCompletionMessageParam[]): Promise<AgentOutput> {
    const maxRetries = 2;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await this.openai.chat.completions.create({
          model: this.config.model,
          messages,
          temperature: 0.1,
          // 要求 LLM 输出 JSON
          response_format: { type: "json_object" },
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
          throw new Error("LLM 返回空内容");
        }

        return this._parseAgentOutput(content);
      } catch (err: any) {
        if (attempt === maxRetries - 1) {
          throw new Error(`LLM 调用失败: ${err.message}`);
        }
        // 重试前等待
        await Bun.sleep(1000);
      }
    }

    throw new Error("LLM 调用失败: 超过最大重试次数");
  }

  /**
   * 解析 LLM 输出为 AgentOutput
   * 
   * 借鉴自 browser-use 的 AgentOutput model validation
   * browser-use 使用 Pydantic 模型验证，我们通过 JSON 解析 + 字段检查实现
   */
  private _parseAgentOutput(content: string): AgentOutput {
    try {
      // 尝试直接解析 JSON
      const parsed = JSON.parse(content);

      return {
        thinking: parsed.thinking || "",
        evaluation_previous_goal: parsed.evaluation_previous_goal || "",
        next_goal: parsed.next_goal || "",
        action: this._normalizeActions(parsed.action),
      };
    } catch {
      // 尝试从文本中提取 JSON（LLM 有时会在 JSON 前后添加额外文字）
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          return {
            thinking: parsed.thinking || "",
            evaluation_previous_goal: parsed.evaluation_previous_goal || "",
            next_goal: parsed.next_goal || "",
            action: this._normalizeActions(parsed.action),
          };
        } catch {}
      }

      // 如果解析完全失败，返回一个 done 动作
      return {
        thinking: "无法解析 LLM 输出",
        evaluation_previous_goal: "",
        next_goal: "",
        action: [{ name: "done", params: { text: "无法理解 LLM 的响应格式，任务终止" } }],
      };
    }
  }

  /** 标准化动作列表 */
  private _normalizeActions(raw: any): Action[] {
    if (!raw) return [];
    if (!Array.isArray(raw)) raw = [raw];
    return raw.map((a: any) => ({
      name: String(a.name || "done"),
      params: a.params || {},
    }));
  }
}
