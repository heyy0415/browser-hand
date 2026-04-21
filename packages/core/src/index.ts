/**
 * @browser-hand/core - 统一导出
 */

export { Agent, type AgentEvent, type AgentEventCallback, type AgentConfig } from "./agent";
export { BrowserController, type BrowserState } from "./browser";
export { CDPClient } from "./cdp";
export { ContextManager } from "./context";
export { extractDOMState, formatBrowserStateText, type DOMState, type InteractiveElement } from "./dom";
export { executeAction, ACTION_DEFINITIONS, type Action, type ActionResult } from "./actions";
export { buildSystemPrompt } from "./prompts";
