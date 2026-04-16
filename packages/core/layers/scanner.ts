/** Layer 2: Scanner (v2.0) — 双轨输出：domText（给 LLM）+ elementMap（给算法） */

import type { Page, CDPSession } from 'playwright';
import { logger } from '../llm';
import type { ScannerResult, ScanOptions, PageSummary, ElementRect, ElementMap, VisibleTextNode } from '../types';
import { EXTRACTION_SCRIPT } from './scanner-extraction-script';

const log = (msg: string, meta?: unknown) => logger.info('scanner', msg, meta);

const WORKER_PATH = import.meta.dir + '/scanner-worker.mjs';

// ── Worker 消息协议 ──────────────────────────────────────────────

interface WorkerProgress {
  type: 'progress';
  data: string;
}

interface WorkerResult {
  type: 'result';
  data: {
    domText: string;
    elementMap: ElementMap;
    totalElements: number;
    visibleText: VisibleTextNode[];
    zonesBoundingBox: Record<string, ElementRect>;
  };
}

interface WorkerError {
  type: 'error';
  data: string;
}

type WorkerMessage = WorkerProgress | WorkerResult | WorkerError;

// ── 回调接口 ─────────────────────────────────────────────────────

export interface ScanCallbacks {
  /** 进度回调 */
  onProgress?: (data: { phase: string; message: string }) => void;
  /** 错误回调 */
  onError?: (error: string) => void;
}

// ── 核心: spawn Node.js 子进程 ───────────────────────────────────

function spawnScanner(
  url: string,
  options: Required<Pick<ScanOptions, 'pageId' | 'timeout' | 'autoScroll' | 'scanFrames'>>,
  callbacks: ScanCallbacks,
): Promise<WorkerResult['data']> {
  return new Promise((resolve, reject) => {
    const child = Bun.spawn(
      [
        'node',
        WORKER_PATH,
        '--url', url,
        '--pageId', options.pageId,
        '--timeout', String(options.timeout),
        '--autoScroll', String(options.autoScroll),
        '--scanFrames', String(options.scanFrames),
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    let stdoutBuffer = '';
    let stderrOutput = '';
    let resolved = false;

    (async () => {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        stdoutBuffer += decoder.decode(value, { stream: true });
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const msg: WorkerMessage = JSON.parse(trimmed);

            switch (msg.type) {
              case 'progress':
                callbacks.onProgress?.({ phase: 'scanning', message: msg.data });
                log(msg.data);
                break;

              case 'result':
                if (!resolved) {
                  resolved = true;
                  resolve(msg.data);
                }
                break;

              case 'error':
                if (!resolved) {
                  resolved = true;
                  callbacks.onError?.(msg.data);
                  reject(new Error(msg.data));
                }
                break;
            }
          } catch {
            // 非 JSON 行，忽略
          }
        }
      }
    })();

    (async () => {
      const reader = child.stderr.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrOutput += decoder.decode(value, { stream: true });
      }
    })();

    child.exited.then((code: number | null) => {
      if (resolved) return;
      const errMsg = code !== 0
        ? `Scanner worker exited with code ${code}: ${stderrOutput.trim()}`
        : `Scanner worker exited without result. stderr: ${stderrOutput.trim()}`;
      callbacks.onError?.(errMsg);
      reject(new Error(errMsg));
    });
  });
}

// ── 页面摘要生成 ─────────────────────────────────────────────────

function buildPageSummary(
  elementMap: ElementMap,
  url: string,
  title: string,
  zonesBoundingBox?: Record<string, ElementRect>,
): PageSummary {
  const entries = Object.values(elementMap);

  const hasSearch = entries.some((el) =>
    el.role === 'searchbox' ||
    (el.zone === 'search') ||
    /search|搜索|keyword|query|kw/i.test(el.rawText + ' ' + el.selector),
  );
  const hasLoginForm = entries.some((el) =>
    /login|登录|signin|sign-in/i.test(el.rawText + ' ' + el.selector),
  );

  // 按区域分组
  const zoneMap = new Map<string, { count: number; selectors: string[] }>();
  for (const el of entries) {
    const zone = el.zone || 'unknown';
    const existing = zoneMap.get(zone) || { count: 0, selectors: [] };
    existing.count++;
    if (el.selector) existing.selectors.push(el.selector);
    zoneMap.set(zone, existing);
  }

  const zoneDescriptions: Record<string, string> = {
    'navigation': '导航区域', 'search': '搜索区域', 'main-content': '主要内容区域',
    'sidebar': '侧边栏', 'header': '页面头部', 'footer': '页面底部',
    'modal': '弹窗/对话框', 'form': '表单区域', 'list': '列表区域',
    'card': '卡片/商品区域', 'trending': '热搜/热门区域', 'unknown': '其他区域',
  };

  const zones = Array.from(zoneMap.entries()).map(([zone, info]) => ({
    zone: zone as PageSummary['zones'][number]['zone'],
    selector: info.selectors[0] || '',
    elementCount: info.count,
    description: zoneDescriptions[zone] || `${zone}区域，${info.count}个元素`,
  }));

  // 页面类型推断
  const urlLower = url.toLowerCase();
  const titleLower = title.toLowerCase();
  let pageType = 'unknown';
  if (hasSearch && /google|baidu|bing|search/i.test(urlLower + titleLower)) pageType = 'search-engine';
  else if (/taobao|jd|amazon|shop|mall/i.test(urlLower + titleLower)) pageType = 'e-commerce';
  else if (/weibo|twitter|douyin|tiktok|bilibili/i.test(urlLower + titleLower)) pageType = 'social-media';

  const mainFunctions: string[] = [];
  if (hasSearch) mainFunctions.push('搜索功能');
  if (hasLoginForm) mainFunctions.push('登录功能');
  if (zoneMap.has('navigation')) mainFunctions.push('导航功能');

  return {
    pageType,
    mainFunctions: mainFunctions.slice(0, 3),
    zones,
    hasSearch,
    hasLoginForm,
    url,
    title,
    zonesBoundingBox,
  };
}

// ── CDP Closed Shadow DOM 穿透 ──────────────────────────────────

async function scanClosedShadowDOM(page: Page): Promise<Array<{ hostSelector: string; internalElements: Array<{ selector: string; role: string; rawText: string }> }>> {
  try {
    const client: CDPSession = await page.context().newCDPSession(page);
    const snapshot = await client.send('DOMSnapshot.captureSnapshot', {
      computedStyles: [],
      includeDOMRects: true,
    });

    // 关闭 CDP session
    await client.detach();

    // 解析快照查找 closed shadow root
    const result: Array<{ hostSelector: string; internalElements: Array<{ selector: string; role: string; rawText: string }> }> = [];
    // DOMSnapshot 返回的 nodes 结构较为复杂，这里做简化处理
    // 后续可按需深度解析
    void snapshot;
    return result;
  } catch (e) {
    log('CDP closed shadow scan failed', e instanceof Error ? e.message : String(e));
    return [];
  }
}

// ── 对外接口 ─────────────────────────────────────────────────────

/**
 * 扫描指定 URL 的页面
 * 通过启动独立的 Node.js 子进程运行 Playwright 扫描
 */
export async function scanPage(
  url: string,
  options: ScanOptions & ScanCallbacks = {},
): Promise<ScannerResult> {
  const {
    pageId = 'p0',
    timeout = 30_000,
    autoScroll = true,
    scanFrames = true,
    onProgress,
    onError,
  } = options;

  log(`start scan: ${url}`);

  const rawResult = await spawnScanner(
    url,
    { pageId, timeout, autoScroll, scanFrames },
    { onProgress, onError },
  );

  const domText: string = rawResult.domText || '';
  const elementMap: ElementMap = rawResult.elementMap || {};
  const totalElements = rawResult.totalElements || Object.keys(elementMap).length;
  const visibleText = rawResult.visibleText || [];
  const zonesBoundingBox = rawResult.zonesBoundingBox || {};

  const pageSummary = buildPageSummary(elementMap, url, '', zonesBoundingBox);

  log(`done: ${totalElements} elements from ${url}`);

  return {
    url,
    title: '',
    domText,
    elementMap,
    visibleText,
    viewport: { width: 1280, height: 720 },
    timestamp: Date.now(),
    totalElements,
    pageSummary,
    zonesBoundingBox,
  };
}

/**
 * 从已有的 Playwright Page 直接扫描页面元素（v2.0 双轨输出）
 * 用于 Runner 状态机内部重入扫描
 */
export async function scanPageFromPlaywrightPage(
  page: Page,
  options: {
    autoScroll?: boolean;
    scanFrames?: boolean;
    onProgress?: (data: { phase: string; message: string }) => void;
  } = {},
): Promise<ScannerResult> {
  const {
    autoScroll = true,
    scanFrames = true,
    onProgress,
  } = options;

  const url = page.url();
  log(`start scan from playwright page: ${url}`);
  onProgress?.({ phase: 'scanning', message: `开始扫描当前页面: ${url}` });

  // 等待页面稳定
  try {
    await page.waitForLoadState('networkidle', { timeout: 5000 });
  } catch {
    // networkidle 超时，继续扫描
  }

  // 滚动触发懒加载
  if (autoScroll) {
    onProgress?.({ phase: 'scanning', message: '滚动页面触发懒加载' });
    try {
      await page.evaluate(() => {
        return new Promise<void>((resolve) => {
          let totalHeight = 0;
          const distance = 300;
          const timer = setInterval(() => {
            window.scrollBy(0, distance);
            totalHeight += distance;
            if (totalHeight >= document.body.scrollHeight) {
              clearInterval(timer);
              window.scrollTo(0, 0);
              setTimeout(resolve, 500);
            }
          }, 100);
        });
      }).catch(() => {});
    } catch {
      // 滚动失败，继续
    }
  }

  // 扫描所有帧，合并 domText 和 elementMap
  const allDomTextLines: string[] = [];
  const allElementMap: ElementMap = {};
  const allVisibleText: VisibleTextNode[] = [];
  const allZonesBoundingBox: Record<string, ElementRect> = {};
  let globalIndex = 0;

  async function scanFrame(frame: import('playwright').Frame, framePath: number[]): Promise<void> {
    let result: { domText: string; elementMap: ElementMap; totalElements: number; visibleText: VisibleTextNode[]; zonesBoundingBox: Record<string, ElementRect> };
    try {
      result = await frame.evaluate(EXTRACTION_SCRIPT) as typeof result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`frame scan error [${framePath.join('.')}]: ${msg}`);
      return;
    }

    // 解析 domText 行，重编号索引以避免跨帧冲突
    const frameDomText = result.domText || '';
    const frameElementMap = result.elementMap || {};
    const frameLineCount = Object.keys(frameElementMap).length;

    if (framePath.length === 0) {
      // 主帧：直接使用
      allDomTextLines.push(frameDomText);
      for (const [idx, entry] of Object.entries(frameElementMap)) {
        allElementMap[Number(idx) + globalIndex] = entry;
      }
    } else {
      // 子帧：重编号索引
      const lines = frameDomText.split('\n');
      for (const line of lines) {
        const reindexed = line.replace(/^\[(\d+)\]/, (_match, idx) => `[${Number(idx) + globalIndex}]`);
        allDomTextLines.push(reindexed);
      }
      for (const [idx, entry] of Object.entries(frameElementMap)) {
        allElementMap[Number(idx) + globalIndex] = entry;
      }
    }

    globalIndex += frameLineCount;

    // 合并 visibleText
    if (result.visibleText) {
      allVisibleText.push(...result.visibleText);
    }

    // 合并 zonesBoundingBox
    if (result.zonesBoundingBox) {
      for (const [zone, bb] of Object.entries(result.zonesBoundingBox)) {
        if (!allZonesBoundingBox[zone]) {
          allZonesBoundingBox[zone] = bb;
        } else {
          const existing = allZonesBoundingBox[zone];
          const x2 = Math.max(existing.x + existing.width, bb.x + bb.width);
          const y2 = Math.max(existing.y + existing.height, bb.y + bb.height);
          existing.x = Math.min(existing.x, bb.x);
          existing.y = Math.min(existing.y, bb.y);
          existing.width = x2 - existing.x;
          existing.height = y2 - existing.y;
        }
      }
    }

    // 递归扫描子帧
    if (scanFrames) {
      let children: import('playwright').Frame[] = [];
      try { children = frame.childFrames(); } catch { /* ignore */ }
      for (let i = 0; i < children.length; i++) {
        await scanFrame(children[i], [...framePath, i]);
      }
    }
  }

  // 扫描主帧
  onProgress?.({ phase: 'scanning', message: '提取页面元素' });
  await scanFrame(page.mainFrame(), []);

  // CDP Closed Shadow DOM 穿透
  try {
    const closedShadowElements = await scanClosedShadowDOM(page);
    if (closedShadowElements.length > 0) {
      log(`found ${closedShadowElements.length} closed shadow hosts`);
      // closed shadow 内部元素暂不加入 elementMap（无法通过 >>> 选择器操作）
      // 但可在 domText 中追加提示行
      for (const host of closedShadowElements) {
        const line = `[${globalIndex}] <closed-shadow-host>${host.internalElements.length > 0 ? ' 内含 ' + host.internalElements.length + ' 个交互元素' : ''}</closed-shadow-host>`;
        allDomTextLines.push(line);
        globalIndex++;
      }
    }
  } catch {
    // CDP 不可用时静默跳过
  }

  // 获取页面标题
  let pageTitle = '';
  try {
    pageTitle = await page.title();
  } catch {
    // ignore
  }

  const domText = allDomTextLines.join('\n');
  const pageSummary = buildPageSummary(allElementMap, url, pageTitle, allZonesBoundingBox);

  log(`done: ${Object.keys(allElementMap).length} elements from playwright page ${url}`);
  onProgress?.({ phase: 'scanning', message: `扫描完成，发现 ${Object.keys(allElementMap).length} 个元素` });

  return {
    url,
    title: pageTitle,
    domText,
    elementMap: allElementMap,
    visibleText: allVisibleText,
    viewport: page.viewportSize() ?? { width: 1920, height: 1080 },
    timestamp: Date.now(),
    totalElements: Object.keys(allElementMap).length,
    pageSummary,
    zonesBoundingBox: allZonesBoundingBox,
  };
}
