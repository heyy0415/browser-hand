/** 浏览器实例注册表 — 按 sessionId 复用浏览器和上下文，支持多轮 Pipeline 共享 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { logger } from './llm';

const log = (msg: string, meta?: unknown) => logger.info('browser-registry', msg, meta);

const browsers = new Map<string, Browser>();
const contexts = new Map<string, BrowserContext>();
const pages = new Map<string, Page>();

export interface BrowserInstance {
  browser: Browser;
  reused: boolean;
}

/** 完整的浏览器会话（浏览器 + 上下文 + 页面） */
export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
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
 * 获取或创建完整的浏览器会话（Browser + Context + Page）
 * 多轮 Pipeline 执行时共享同一个 Context 和 Page
 */
export async function getOrCreateSession(
  sessionId: string,
  headless: boolean = false,
): Promise<BrowserSession> {
  const { browser, reused } = await getOrCreateBrowser(sessionId, headless);

  // 尝试复用已有的 Context 和 Page
  const existingContext = contexts.get(sessionId);
  if (existingContext && !existingContext.pages().some(p => p.isClosed())) {
    const existingPage = pages.get(sessionId);
    if (existingPage && !existingPage.isClosed()) {
      log('reusing session', { sessionId });
      return { browser, context: existingContext, page: existingPage, reused: true };
    }
  }

  // 创建新的 Context 和 Page
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN',
  });

  const page = await context.newPage();

  contexts.set(sessionId, context);
  pages.set(sessionId, page);

  log('created session', { sessionId, reused });
  return { browser, context, page, reused: false };
}

/**
 * 更新会话中的 Page 引用（当页面跳转/新 tab 打开时）
 */
export function updateSessionPage(sessionId: string, page: Page): void {
  pages.set(sessionId, page);
  log('updated session page', { sessionId, url: page.url() });
}

/**
 * 获取会话中的当前 Page
 */
export function getSessionPage(sessionId: string): Page | null {
  const page = pages.get(sessionId);
  if (page && !page.isClosed()) return page;
  return null;
}

/**
 * 关闭并移除指定 sessionId 的浏览器实例
 */
export async function closeBrowser(sessionId: string): Promise<void> {
  const context = contexts.get(sessionId);
  if (context) {
    await context.close().catch(() => {});
    contexts.delete(sessionId);
    pages.delete(sessionId);
  }
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
  for (const [, context] of contexts) {
    await context.close().catch(() => {});
  }
  contexts.clear();
  pages.clear();
  for (const [, browser] of browsers) {
    await browser.close().catch(() => {});
    log('closed browser', {});
  }
  browsers.clear();
}

/**
 * 获取当前注册的浏览器数量
 */
export function getBrowserCount(): number {
  return browsers.size;
}
