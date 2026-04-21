/**
 * DOM 状态提取 - 基于 Accessibility Tree
 * 
 * 借鉴自 browser-use 的 dom/service.py + dom/serializer/serializer.py
 * browser-use 通过 CDP 三源数据（Accessibility Tree + DOM Tree + DOMSnapshot）合并为 EnhancedDOMTreeNode
 * 我们精简为 CDP Accessibility.getFullAXTree，同样实现元素索引分配和文本序列化
 */

import type { CDPClient } from "./cdp";

/** 可交互元素信息 */
export interface InteractiveElement {
  index: number;
  role: string;
  name: string;
  backendNodeId: number;
  url?: string;       // 链接的 href
  value?: string;     // 输入框的当前值
  description?: string;
  checked?: boolean;
  disabled?: boolean;
}

/** DOM 状态 */
export interface DOMState {
  /** 序列化后的页面文本表示，供 LLM 阅读 */
  elementTreeText: string;
  /** 索引 -> 可交互元素 映射，用于动作执行时定位 */
  selectorMap: Map<number, InteractiveElement>;
  /** 当前页面 URL */
  url: string;
  /** 当前页面标题 */
  title: string;
}

/** AX 树节点（CDP Accessibility.getFullAXTree 返回的节点结构） */
interface AXNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  description?: { type: string; value: string };
  value?: { type: string; value: string };
  properties?: Array<{ name: string; value: { type: string; value: any } }>;
  childIds?: string[];
  ignored?: boolean;
}

/** 可交互的 ARIA role 集合 */
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "treeitem",
  "progressbar",
  "scrollbar",
  "heading",
]);

/**
 * 从 CDP 提取页面 DOM 状态
 * 
 * 借鉴自 browser-use dom/service.py 的 get_serialized_dom_tree() 方法
 * browser-use 同时获取 AX Tree + DOM + Snapshot 三源数据
 * 我们精简为仅获取 Accessibility Tree，但保留核心的索引分配机制
 */
export async function extractDOMState(cdp: CDPClient): Promise<DOMState> {
  // 通过 CDP 获取完整的 Accessibility Tree
  // 借鉴自 browser-use 的 cdp_use.cdp.accessibility.commands.GetFullAXTreeReturns
  const axResult = await cdp.send("Accessibility.getFullAXTree");
  const nodes: AXNode[] = axResult.nodes || [];

  // 获取当前页面 URL 和标题
  const [urlResult, titleResult] = await Promise.all([
    cdp.send("Runtime.evaluate", {
      expression: "window.location.href",
      returnByValue: true,
    }),
    cdp.send("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    }),
  ]);

  const url = urlResult?.result?.value || "";
  const title = titleResult?.result?.value || "";

  // 过滤出可交互元素并分配索引
  // 借鉴自 browser-use dom/serializer/clickable_elements.py 的 ClickableElementDetector
  const selectorMap = new Map<number, InteractiveElement>();
  const interactiveNodes: AXNode[] = [];
  let index = 0;

  for (const node of nodes) {
    if (node.ignored || !node.backendDOMNodeId) continue;
    
    const role = node.role?.value || "";
    const name = node.name?.value || "";
    
    // 判断是否为可交互元素
    if (!isInteractive(node)) continue;

    // 跳过没有名称且不是关键交互元素的节点
    if (!name && role !== "textbox" && role !== "searchbox" && role !== "combobox") continue;

    const element: InteractiveElement = {
      index,
      role,
      name,
      backendNodeId: node.backendDOMNodeId,
      description: node.description?.value,
      value: node.value?.value,
    };

    // 解析 properties
    if (node.properties) {
      for (const prop of node.properties) {
        if (prop.name === "checked") element.checked = prop.value.value;
        if (prop.name === "disabled") element.disabled = prop.value.value;
        if (prop.name === "url") element.url = prop.value.value;
      }
    }

    selectorMap.set(index, element);
    interactiveNodes.push(node);
    index++;
  }

  // 序列化为 LLM 可读的文本
  // 借鉴自 browser-use dom/views.py 的 SerializedDOMState.llm_representation()
  // browser-use 用 DOMTreeSerializer 递归序列化整棵 DOM 树
  // 我们精简为直接序列化可交互元素列表
  const elementTreeText = serializeElements(interactiveNodes, selectorMap);

  return { elementTreeText, selectorMap, url, title };
}

/** 判断 AX 节点是否可交互 */
function isInteractive(node: AXNode): boolean {
  const role = node.role?.value || "";
  if (INTERACTIVE_ROLES.has(role)) return true;
  // 检查 focusable property
  if (node.properties?.some(p => p.name === "focusable" && p.value.value === true)) return true;
  return false;
}

/**
 * 将可交互元素序列化为文本供 LLM 阅读
 * 
 * 借鉴自 browser-use dom/serializer/serializer.py 的 serialize_tree() 方法
 * browser-use 递归序列化整棵 DOM 树，在可交互节点旁标注 [index]
 * 我们直接列出所有可交互元素，每个带有 [index] 标记
 */
function serializeElements(nodes: AXNode[], selectorMap: Map<number, InteractiveElement>): string {
  const lines: string[] = [];
  
  for (const node of nodes) {
    const element = Array.from(selectorMap.values()).find(
      e => e.backendNodeId === node.backendDOMNodeId
    );
    if (!element) continue;

    const parts: string[] = [];
    parts.push(`[${element.index}]`);
    parts.push(`<${element.role}>`);
    if (element.name) parts.push(`"${element.name}"`);
    if (element.url) parts.push(`url="${element.url}"`);
    if (element.value) parts.push(`value="${element.value}"`);
    if (element.description) parts.push(`desc="${element.description}"`);
    if (element.checked != null) parts.push(`checked=${element.checked}`);
    if (element.disabled) parts.push("disabled");

    lines.push(parts.join(" "));
  }

  return lines.join("\n");
}

/** 格式化完整的浏览器状态文本（用于 LLM 上下文） */
export function formatBrowserStateText(state: DOMState): string {
  // 借鉴自 browser-use agent/message_manager/service.py 中的浏览器状态格式化
  let text = `[Current page URL]: ${state.url}\n`;
  text += `[Current page title]: ${state.title}\n\n`;
  text += `[Interactive elements on page]:\n`;
  if (state.elementTreeText) {
    text += state.elementTreeText;
  } else {
    text += "(No interactive elements found)";
  }
  return text;
}
