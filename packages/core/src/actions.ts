/**
 * 动作定义与执行
 * 
 * 借鉴自 browser-use 的 tools/service.py - Tools 类
 * browser-use 通过 Registry 模式注册动作处理器（@register_action 装饰器）
 * 我们精简为直接定义6种核心动作及其执行逻辑
 */

import type { BrowserController } from "./browser";
import type { DOMState } from "./dom";

/** LLM 输出的单个动作 */
export interface Action {
  name: string;
  params: Record<string, any>;
}

/** 动作执行结果 - 借鉴自 browser-use agent/views.py 的 ActionResult */
export interface ActionResult {
  success: boolean;
  summary: string;
  error?: string;
}

/** 动作定义（供 System Prompt 中描述给 LLM） */
export interface ActionDefinition {
  name: string;
  description: string;
  params: Record<string, { type: string; description: string; required?: boolean }>;
}

/**
 * 所有可用动作定义
 * 借鉴自 browser-use tools/service.py 中通过 @register_action 注册的动作列表
 */
export const ACTION_DEFINITIONS: ActionDefinition[] = [
  {
    name: "click",
    description: "点击页面上的元素。通过索引引用元素。",
    params: {
      index: { type: "number", description: "要点击的元素索引", required: true },
    },
  },
  {
    name: "type",
    description: "在输入框中输入文本。会先清空已有内容再输入。",
    params: {
      index: { type: "number", description: "要输入的元素索引", required: true },
      text: { type: "string", description: "要输入的文本内容", required: true },
    },
  },
  {
    name: "scroll",
    description: "滚动页面。",
    params: {
      direction: { type: "string", description: "滚动方向: up 或 down", required: true },
      amount: { type: "number", description: "滚动量（默认3）" },
    },
  },
  {
    name: "navigate",
    description: "导航到指定 URL。",
    params: {
      url: { type: "string", description: "要访问的 URL", required: true },
    },
  },
  {
    name: "go_back",
    description: "返回上一页。",
    params: {},
  },
  {
    name: "done",
    description: "任务已完成，返回最终结果。",
    params: {
      text: { type: "string", description: "任务的最终结果或总结", required: true },
    },
  },
];

/**
 * 执行单个动作
 * 
 * 借鉴自 browser-use tools/service.py 的 Tools.act() 方法
 * browser-use 通过 Registry 查找注册的 handler 执行动作
 * 我们通过 switch-case 直接分发到对应的执行逻辑
 */
export async function executeAction(
  action: Action,
  browser: BrowserController,
  domState: DOMState,
): Promise<ActionResult> {
  try {
    switch (action.name) {
      case "click": {
        const idx = action.params.index;
        const element = domState.selectorMap.get(idx);
        if (!element) {
          return { success: false, summary: `元素索引 ${idx} 不存在`, error: "Element not found" };
        }
        // 借鉴自 browser-use 的 click 动作：通过 selectorMap 获取元素后执行 CDP 点击
        await browser.clickByBackendNodeId(element.backendNodeId);
        return { success: true, summary: `点击了 [${idx}] <${element.role}> "${element.name}"` };
      }

      case "type": {
        const idx = action.params.index;
        const text = action.params.text;
        const element = domState.selectorMap.get(idx);
        if (!element) {
          return { success: false, summary: `元素索引 ${idx} 不存在`, error: "Element not found" };
        }
        // 借鉴自 browser-use 的 input_text 动作：先点击聚焦再输入
        await browser.typeByBackendNodeId(element.backendNodeId, text);
        return { success: true, summary: `在 [${idx}] <${element.role}> "${element.name}" 中输入了 "${text}"` };
      }

      case "scroll": {
        const direction = action.params.direction === "up" ? "up" : "down";
        const amount = action.params.amount || 3;
        // 借鉴自 browser-use 的 scroll 动作
        await browser.scroll(direction, amount);
        return { success: true, summary: `向下${direction === "down" ? "下" : "上"}滚动了 ${amount} 屏` };
      }

      case "navigate": {
        const url = action.params.url;
        if (!url) {
          return { success: false, summary: "缺少 URL 参数", error: "Missing URL" };
        }
        // 借鉴自 browser-use 的 navigate 动作
        await browser.navigate(url);
        return { success: true, summary: `导航到 ${url}` };
      }

      case "go_back": {
        // 借鉴自 browser-use 的 go_back 动作
        await browser.goBack();
        return { success: true, summary: "返回上一页" };
      }

      case "done": {
        return { success: true, summary: action.params.text || "任务完成" };
      }

      default:
        return { success: false, summary: `未知动作: ${action.name}`, error: "Unknown action" };
    }
  } catch (err: any) {
    // 借鉴自 browser-use 的异常处理：将错误信息反馈给 Agent 作为下一轮输入
    return {
      success: false,
      summary: `动作 ${action.name} 执行失败: ${err.message}`,
      error: err.message,
    };
  }
}
