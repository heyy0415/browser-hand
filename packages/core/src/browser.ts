/**
 * 浏览器控制器
 * 
 * 借鉴自 browser-use 的 browser/session.py - BrowserSession 类
 * browser-use 通过 cdp_use 管理浏览器会话，我们通过自实现的 CDPClient 管理浏览器
 */

import { CDPClient } from "./cdp";
import { extractDOMState, type DOMState } from "./dom";

export interface BrowserState {
  url: string;
  title: string;
  domState: DOMState;
  screenshot?: string; // base64 encoded
}

export class BrowserController {
  private cdp: CDPClient;
  private port: number;

  constructor(port = 9222) {
    this.cdp = new CDPClient();
    this.port = port;
  }

  /** 启动浏览器并连接 CDP */
  async start(): Promise<void> {
    await this.cdp.launchAndConnect(this.port);
  }

  /** 关闭浏览器 */
  async stop(): Promise<void> {
    this.cdp.close();
  }

  /** 确保 CDP 连接可用，断开则自动重连 */
  private async ensureConnection(): Promise<void> {
    if (this.cdp.connected) return;
    // CDP 断开，尝试重连
    await this.cdp.reconnect(this.port);
  }

  /** 判断是否为空白页面 */
  private isBlankPage(url: string): boolean {
    return !url
      || url === "about:blank"
      || url === ""
      || url.startsWith("chrome://newtab")
      || url.startsWith("chrome-search://");
  }

  /** 获取完整的浏览器状态（DOM + 截图） */
  async getState(): Promise<BrowserState> {
    // 借鉴自 browser-use agent/service.py 的 _prepare_context() 方法
    // browser-use 在每步循环中先获取浏览器状态，然后拼接到 LLM 上下文
    await this.ensureConnection();

    // 逐个获取而非 Promise.all，避免某个失败导致整体崩溃
    let domState: DOMState;
    let url = "";
    let title = "";
    let screenshot = "";

    try {
      domState = await extractDOMState(this.cdp);
    } catch (err: any) {
      // DOM 提取失败时返回空状态而非抛异常
      domState = { elementTreeText: `(DOM 提取失败: ${err.message})`, selectorMap: new Map(), url: "", title: "" };
    }

    try { url = await this.cdp.getCurrentUrl(); } catch {}
    try { title = await this.cdp.getCurrentTitle(); } catch {}

    // 空白页面跳过截图，避免发送无意义的白图
    if (!this.isBlankPage(url)) {
      try { screenshot = await this.takeScreenshot(); } catch {}
    }

    return { url, title, domState, screenshot };
  }

  /** 截图 - 借鉴自 browser-use 的 Page.captureScreenshot CDP 命令 */
  async takeScreenshot(): Promise<string> {
    try {
      const result = await this.cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 30, // 降低质量减少 SSE 传输量，避免大 base64 导致连接超时
      });
      return result.data; // base64
    } catch {
      return "";
    }
  }

  /** 导航到 URL - 借鉴自 browser-use 的 navigate 动作 */
  async navigate(url: string): Promise<void> {
    await this.ensureConnection();
    await this.cdp.send("Page.navigate", { url });
    // 等待页面加载
    await this.waitForPageLoad();
  }

  /** 返回上一页 - 借鉴自 browser-use 的 go_back 动作 */
  async goBack(): Promise<void> {
    await this.ensureConnection();
    await this.cdp.send("Runtime.evaluate", {
      expression: "history.back()",
      awaitPromise: true,
    });
    await this.waitForPageLoad();
  }

  /** 通过 backendNodeId 点击元素 */
  async clickByBackendNodeId(backendNodeId: number): Promise<void> {
    // 借鉴自 browser-use tools/service.py 中的 click 动作执行
    await this.ensureConnection();

    const resolved = await this.cdp.send("DOM.resolveNode", { backendNodeId });
    const objectId = resolved.object.objectId;

    // 获取元素的位置信息用于鼠标点击
    const boxModel = await this.cdp.send("DOM.getBoxModel", { backendNodeId });
    const content = boxModel.model.content;
    const centerX = (content[0] + content[2] + content[4] + content[6]) / 4;
    const centerY = (content[1] + content[3] + content[5] + content[7]) / 4;

    // 通过 CDP Input.dispatchMouseEvent 模拟鼠标点击
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: centerX,
      y: centerY,
      button: "left",
      clickCount: 1,
    });
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: centerX,
      y: centerY,
      button: "left",
      clickCount: 1,
    });

    // 释放 RemoteObject
    if (objectId) {
      await this.cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});
    }

    await Bun.sleep(500);
  }

  /** 通过 backendNodeId 在元素中输入文本 */
  async typeByBackendNodeId(backendNodeId: number, text: string): Promise<void> {
    // 借鉴自 browser-use tools/service.py 中的 input_text 动作
    await this.ensureConnection();
    await this.clickByBackendNodeId(backendNodeId);

    // 清空已有内容
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "a", code: "KeyA", modifiers: 2,
    });
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "a", code: "KeyA", modifiers: 2,
    });
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "Backspace", code: "Backspace",
    });
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Backspace", code: "Backspace",
    });

    // 通过 CDP Input.insertText 输入文本
    await this.cdp.send("Input.insertText", { text });
    await Bun.sleep(300);
  }

  /** 滚动页面 */
  async scroll(direction: "up" | "down", amount = 3): Promise<void> {
    await this.ensureConnection();
    const delta = direction === "down" ? amount * 100 : -amount * 100;
    await this.cdp.send("Runtime.evaluate", {
      expression: `window.scrollBy(0, ${delta})`,
    });
    await Bun.sleep(300);
  }

  /** 等待页面加载完成 */
  private async waitForPageLoad(timeout = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const result = await this.cdp.send("Runtime.evaluate", {
          expression: "document.readyState",
          returnByValue: true,
        });
        if (result?.result?.value === "complete" || result?.result?.value === "interactive") {
          await Bun.sleep(200);
          return;
        }
      } catch {}
      await Bun.sleep(200);
    }
  }

  get cdpClient(): CDPClient {
    return this.cdp;
  }
}
