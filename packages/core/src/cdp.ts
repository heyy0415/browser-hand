/**
 * CDP (Chrome DevTools Protocol) 客户端
 * 
 * 借鉴自 browser-use 的 cdp_use 库：通过 WebSocket 直连 Chrome DevTools Protocol
 * browser-use 通过 cdp_use 库封装 CDP 连接，我们直接实现精简版 CDP 客户端
 */

import type { Subprocess } from "bun";

let msgId = 0;

export class CDPClient {
  private ws: WebSocket | null = null;
  private pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (err: Error) => void;
  }>();
  private eventHandlers = new Map<string, Set<(params: any) => void>>();
  private chromeProcess: Subprocess | null = null;
  private _url = "";
  private _title = "";
  private _connected = false;

  /** 是否已连接 */
  get connected(): boolean {
    return this._connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** 连接到 Chrome 实例 */
  async connect(wsEndpoint: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsEndpoint);
      this.ws.onopen = () => {
        this._connected = true;
        resolve();
      };
      this.ws.onerror = (e) => reject(new Error(`CDP WebSocket 连接失败`));
      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);
          this._onMessage(data);
        } catch {}
      };
      this.ws.onclose = () => {
        this._connected = false;
        // 清理所有 pending 请求
        for (const [, p] of this.pending) {
          p.reject(new Error("CDP 连接已关闭"));
        }
        this.pending.clear();
      };
    });
  }

  /** 发送 CDP 命令并等待响应 */
  send(method: string, params: Record<string, any> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error("CDP 未连接"));
        return;
      }
      const id = ++msgId;
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ id, method, params });
      try {
        this.ws!.send(msg);
      } catch (err: any) {
        this.pending.delete(id);
        reject(new Error(`CDP 发送失败: ${err.message}`));
        return;
      }
      // 30s 超时
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 命令超时: ${method}`));
        }
      }, 30000);
    });
  }

  /** 监听 CDP 事件 */
  on(event: string, handler: (params: any) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  /** 移除事件监听 */
  off(event: string, handler: (params: any) => void): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  /** 关闭连接 */
  close(): void {
    this._connected = false;
    this.ws?.close();
    this.ws = null;
    if (this.chromeProcess) {
      this.chromeProcess.kill();
      this.chromeProcess = null;
    }
  }

  /**
   * 重新连接到当前 Chrome 实例
   * 当页面导航导致 CDP target 失效时，需要重新获取 target 并连接
   */
  async reconnect(port: number): Promise<void> {
    // 关闭旧连接（不杀 Chrome 进程）
    this._connected = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    // 清理 pending
    for (const [, p] of this.pending) {
      p.reject(new Error("CDP 重连中"));
    }
    this.pending.clear();

    // 重新获取 WebSocket URL
    for (let i = 0; i < 10; i++) {
      await Bun.sleep(500);
      try {
        const resp = await fetch(`http://localhost:${port}/json`);
        const targets: any[] = await resp.json();
        const page = targets.find((t: any) => t.type === "page");
        if (page?.webSocketDebuggerUrl) {
          await this.connect(page.webSocketDebuggerUrl);
          // 重新启用 CDP 域
          await this.send("Page.enable");
          await this.send("DOM.enable");
          await this.send("Runtime.enable");
          await this.send("Network.enable");
          return;
        }
      } catch {
        // 继续等待
      }
    }
    throw new Error("CDP 重连失败：无法获取 Chrome target");
  }

  /** 启动 Chrome 并通过 CDP 连接 */
  async launchAndConnect(port = 9222): Promise<void> {
    // 查找系统 Chrome 路径
    const chromePath = findChrome();
    if (!chromePath) {
      throw new Error("未找到 Chrome 浏览器，请安装 Chrome 或 Chromium");
    }

    // 启动 Chrome，开启远程调试端口
    this.chromeProcess = Bun.spawn([
      chromePath,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-client-side-phishing-detection",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-hang-monitor",
      "--disable-popup-blocking",
      "--disable-prompt-on-repost",
      "--disable-sync",
      "--disable-translate",
      "--metrics-recording-only",
      "--safebrowsing-disable-auto-update",
      `--user-data-dir=/tmp/browser-hand-chrome-${port}`,
      "about:blank",
    ], {
      stderr: "ignore",
      stdout: "ignore",
    });

    // 等待 Chrome 启动并获取 WebSocket 调试 URL
    let wsUrl = "";
    for (let i = 0; i < 20; i++) {
      await Bun.sleep(500);
      try {
        const resp = await fetch(`http://localhost:${port}/json`);
        const targets: any[] = await resp.json();
        const page = targets.find((t: any) => t.type === "page");
        if (page?.webSocketDebuggerUrl) {
          wsUrl = page.webSocketDebuggerUrl;
          break;
        }
      } catch {
        // Chrome 还没启动好，继续等待
      }
    }

    if (!wsUrl) {
      throw new Error("无法连接到 Chrome 调试端口");
    }

    await this.connect(wsUrl);

    // 启用必要的 CDP 域
    await this.send("Page.enable");
    await this.send("DOM.enable");
    await this.send("Runtime.enable");
    await this.send("Network.enable");

    // 监听页面事件以更新 URL 和标题
    this.on("Page.frameNavigated", (params: any) => {
      if (params.frame?.url) {
        this._url = params.frame.url;
      }
    });
  }

  /** 获取当前页面 URL */
  async getCurrentUrl(): Promise<string> {
    try {
      const result = await this.send("Runtime.evaluate", {
        expression: "window.location.href",
        returnByValue: true,
      });
      this._url = result?.result?.value || this._url;
    } catch {}
    return this._url;
  }

  /** 获取当前页面标题 */
  async getCurrentTitle(): Promise<string> {
    try {
      const result = await this.send("Runtime.evaluate", {
        expression: "document.title",
        returnByValue: true,
      });
      this._title = result?.result?.value || this._title;
    } catch {}
    return this._title;
  }

  /** 处理 CDP 消息 */
  private _onMessage(data: any): void {
    // 命令响应
    if (data.id != null && this.pending.has(data.id)) {
      const p = this.pending.get(data.id)!;
      this.pending.delete(data.id);
      if (data.error) {
        p.reject(new Error(`CDP 错误: ${data.error.message}`));
      } else {
        p.resolve(data.result);
      }
      return;
    }
    // 事件通知
    if (data.method) {
      const handlers = this.eventHandlers.get(data.method);
      if (handlers) {
        for (const h of handlers) {
          try { h(data.params); } catch {}
        }
      }
    }
  }
}

/** 查找系统中的 Chrome 可执行文件路径 */
function findChrome(): string | null {
  const candidates: Record<string, string[]> = {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ],
    linux: [
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
    ],
    win32: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
  };
  const platform = process.platform as string;
  const paths = candidates[platform] || candidates.linux;
  for (const p of paths) {
    try {
      const file = Bun.file(p);
      if (file.size > 0) return p;
    } catch {}
  }
  return null;
}
