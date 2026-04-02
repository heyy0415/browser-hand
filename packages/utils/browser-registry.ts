/** 浏览器实例注册表 — 按 sessionId 复用浏览器，pipeline 执行完毕后不关闭 */

import { chromium, type Browser } from 'playwright';
import { logger } from './util';

const log = (msg: string, meta?: unknown) => logger.info('browser-registry', msg, meta);

const browsers = new Map<string, Browser>();

export interface BrowserInstance {
  browser: Browser;
  reused: boolean;
}

/**
 * 获取或创建浏览器实例
 * - 已存在则复用（reused=true）
 * - 不存在则新建并注册
 */
export async function getOrCreateBrowser(
  sessionId: string,
  headless: boolean = false,
): Promise<BrowserInstance> {
  const existing = browsers.get(sessionId);
  if (existing) {
    log('reusing browser', { sessionId });
    return { browser: existing, reused: true };
  }

  const browser = await chromium.launch({
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });

  browsers.set(sessionId, browser);
  log('created browser', { sessionId, headless });

  return { browser, reused: false };
}

/**
 * 关闭并移除指定 sessionId 的浏览器实例
 */
export async function closeBrowser(sessionId: string): Promise<void> {
  const browser = browsers.get(sessionId);
  if (browser) {
    await browser.close().catch(() => {});
    browsers.delete(sessionId);
    log('closed browser', { sessionId });
  }
}

/**
 * 关闭所有浏览器实例
 */
export async function closeAllBrowsers(): Promise<void> {
  for (const [sessionId, browser] of browsers) {
    await browser.close().catch(() => {});
    log('closed browser', { sessionId });
  }
  browsers.clear();
}

/**
 * 获取当前注册的浏览器数量
 */
export function getBrowserCount(): number {
  return browsers.size;
}
