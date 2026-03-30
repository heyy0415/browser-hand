/** runner 层 — 执行器层，支持 Web (Playwright via Node.js) 和 Extension (Script Injection) 两种模式 */

import { createSSEStream, logger } from '../utils';
import type { AbstractorResult, RunnerResult, ActionResult, ClientType } from '../types';

const log = (msg: string, meta?: unknown) => logger.info('runner', msg, meta);

/**
 * 将伪代码转换为 Playwright 可执行的代码
 */
function pseudoCodeToPlaywright(code: string[]): string[] {
  return code.map((line) => {
    // open('url')
    if (line.startsWith('open(')) {
      const url = line.match(/open\('([^']+)'\)/)?.[1];
      return `await page.goto('${url}', { waitUntil: 'networkidle' });`;
    }
    // click('selector')
    if (line.startsWith('click(')) {
      const selector = line.match(/click\('([^']+)'\)/)?.[1];
      return `await page.click('${selector}');`;
    }
    // fill('selector', 'value')
    if (line.startsWith('fill(')) {
      const match = line.match(/fill\('([^']+)',\s*'([^']+)'\)/);
      const selector = match?.[1];
      const value = match?.[2]?.replace(/'/g, "\\'");
      return `await page.fill('${selector}', '${value}');`;
    }
    // doubleClick('selector')
    if (line.startsWith('doubleClick(')) {
      const selector = line.match(/doubleClick\('([^']+)'\)/)?.[1];
      return `await page.dblclick('${selector}');`;
    }
    // rightClick('selector')
    if (line.startsWith('rightClick(')) {
      const selector = line.match(/rightClick\('([^']+)'\)/)?.[1];
      return `await page.click('${selector}', { button: 'right' });`;
    }
    // select('selector', 'value')
    if (line.startsWith('select(')) {
      const match = line.match(/select\('([^']+)',\s*'([^']+)'\)/);
      const selector = match?.[1];
      const value = match?.[2];
      return `await page.selectOption('${selector}', '${value}');`;
    }
    // check('selector')
    if (line.startsWith('check(')) {
      const selector = line.match(/check\('([^']+)'\)/)?.[1];
      return `await page.check('${selector}');`;
    }
    // uncheck('selector')
    if (line.startsWith('uncheck(')) {
      const selector = line.match(/uncheck\('([^']+)'\)/)?.[1];
      return `await page.uncheck('${selector}');`;
    }
    // getText('selector')
    if (line.startsWith('getText(')) {
      const selector = line.match(/getText\('([^']+)'\)/)?.[1];
      return `const text = await page.textContent('${selector}'); console.log('getText:', text);`;
    }
    // scrollUp()
    if (line === 'scrollUp()') {
      return `await page.evaluate(() => window.scrollBy(0, -window.innerHeight));`;
    }
    // scrollDown()
    if (line === 'scrollDown()') {
      return `await page.evaluate(() => window.scrollBy(0, window.innerHeight));`;
    }
    return line;
  });
}

/**
 * 将伪代码转换为浏览器插件可执行的脚本
 */
function pseudoCodeToExtensionScript(code: string[]): string {
  const lines = code.map((line) => {
    // open('url')
    if (line.startsWith('open(')) {
      const url = line.match(/open\('([^']+)'\)/)?.[1];
      return `
try {
  console.log('[action] 打开URL:', '${url}');
  setTimeout(() => {
    window.location.href = '${url}';
  }, 100);
} catch (err) {
  console.error('[action] 打开URL失败:', err);
}
      `.trim();
    }
    // click('selector')
    if (line.startsWith('click(')) {
      const selector = line.match(/click\('([^']+)'\)/)?.[1];
      return `
try {
  const el = document.querySelector('${selector}');
  if (el) {
    el.click();
    console.log('[action] 成功点击:', '${selector}');
  } else {
    console.warn('[action] 元素未找到:', '${selector}');
  }
} catch (err) {
  console.error('[action] 点击失败:', err);
}
      `.trim();
    }
    // fill('selector', 'value')
    if (line.startsWith('fill(')) {
      const match = line.match(/fill\('([^']+)',\s*'([^']+)'\)/);
      const selector = match?.[1];
      const value = match?.[2]?.replace(/'/g, "\\'");
      return `
try {
  const el = document.querySelector('${selector}');
  if (el && el instanceof HTMLInputElement) {
    el.value = '${value}';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    console.log('[action] 成功填充:', '${selector}', '${value}');
  } else {
    console.warn('[action] 输入框未找到:', '${selector}');
  }
} catch (err) {
  console.error('[action] 填充失败:', err);
}
      `.trim();
    }
    // doubleClick('selector')
    if (line.startsWith('doubleClick(')) {
      const selector = line.match(/doubleClick\('([^']+)'\)/)?.[1];
      return `
try {
  const el = document.querySelector('${selector}');
  if (el) {
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    console.log('[action] 成功双击:', '${selector}');
  } else {
    console.warn('[action] 元素未找到:', '${selector}');
  }
} catch (err) {
  console.error('[action] 双击失败:', err);
}
      `.trim();
    }
    // rightClick('selector')
    if (line.startsWith('rightClick(')) {
      const selector = line.match(/rightClick\('([^']+)'\)/)?.[1];
      return `
try {
  const el = document.querySelector('${selector}');
  if (el) {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    console.log('[action] 成功右击:', '${selector}');
  } else {
    console.warn('[action] 元素未找到:', '${selector}');
  }
} catch (err) {
  console.error('[action] 右击失败:', err);
}
      `.trim();
    }
    // select('selector', 'value')
    if (line.startsWith('select(')) {
      const match = line.match(/select\('([^']+)',\s*'([^']+)'\)/);
      const selector = match?.[1];
      const value = match?.[2];
      return `
try {
  const el = document.querySelector('${selector}');
  if (el && el instanceof HTMLSelectElement) {
    el.value = '${value}';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    console.log('[action] 成功选择:', '${selector}', '${value}');
  } else {
    console.warn('[action] 下拉框未找到:', '${selector}');
  }
} catch (err) {
  console.error('[action] 选择失败:', err);
}
      `.trim();
    }
    // check('selector')
    if (line.startsWith('check(')) {
      const selector = line.match(/check\('([^']+)'\)/)?.[1];
      return `
try {
  const el = document.querySelector('${selector}');
  if (el && el instanceof HTMLInputElement) {
    el.checked = true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    console.log('[action] 成功勾选:', '${selector}');
  } else {
    console.warn('[action] 复选框未找到:', '${selector}');
  }
} catch (err) {
  console.error('[action] 勾选失败:', err);
}
      `.trim();
    }
    // uncheck('selector')
    if (line.startsWith('uncheck(')) {
      const selector = line.match(/uncheck\('([^']+)'\)/)?.[1];
      return `
try {
  const el = document.querySelector('${selector}');
  if (el && el instanceof HTMLInputElement) {
    el.checked = false;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    console.log('[action] 成功取消勾选:', '${selector}');
  } else {
    console.warn('[action] 复选框未找到:', '${selector}');
  }
} catch (err) {
  console.error('[action] 取消勾选失败:', err);
}
      `.trim();
    }
    // getText('selector')
    if (line.startsWith('getText(')) {
      const selector = line.match(/getText\('([^']+)'\)/)?.[1];
      return `
try {
  const el = document.querySelector('${selector}');
  if (el) {
    const text = el.textContent;
    console.log('[action] 获取文本:', '${selector}', text);
  } else {
    console.warn('[action] 元素未找到:', '${selector}');
  }
} catch (err) {
  console.error('[action] 获取文本失败:', err);
}
      `.trim();
    }
    // scrollUp()
    if (line === 'scrollUp()') {
      return `window.scrollBy(0, -window.innerHeight); console.log('[action] 向上滚动');`;
    }
    // scrollDown()
    if (line === 'scrollDown()') {
      return `window.scrollBy(0, window.innerHeight); console.log('[action] 向下滚动');`;
    }
    return line;
  });

  return lines.join('\n');
}

/**
 * 执行伪代码列表
 */
export async function executeRunner(
  abstractorResult: AbstractorResult,
  clientType: ClientType = 'web',
  page?: any, // Playwright Page 对象（仅用于测试）
): Promise<{ stream: ReadableStream<Uint8Array>; result: Promise<RunnerResult> }> {
  const { stream, send, close } = createSSEStream();
  send('start', { message: '正在执行动作...' });
  log('start', { clientType, codeLines: abstractorResult.code.length });

  const runnerResult: RunnerResult = {
    results: [],
  };

  const result = new Promise<RunnerResult>(async (resolve, reject) => {
    try {
      if (clientType === 'web') {
        // Web 端：生成 Playwright 代码，由 Node.js 子进程执行
        const playwrightCode = pseudoCodeToPlaywright(abstractorResult.code);
        
        for (let i = 0; i < playwrightCode.length; i++) {
          const step = i + 1;
          const actionResult: ActionResult = {
            step,
            success: true,
            data: { code: playwrightCode[i] },
          };
          runnerResult.results.push(actionResult);
          send('action', actionResult);
          
          log(`step ${step} prepared`, { code: playwrightCode[i] });
        }
      } else if (clientType === 'extension') {
        // Extension 端：转换为浏览器脚本（由前端接收后执行）
        for (let i = 0; i < abstractorResult.code.length; i++) {
          const step = i + 1;
          const pseudoCode = abstractorResult.code[i];
          const script = pseudoCodeToExtensionScript([pseudoCode]);
          
          const actionResult: ActionResult = {
            step,
            success: true,
            data: {
              type: 'script-injection',
              pseudoCode,
              script,
            },
          };
          runnerResult.results.push(actionResult);
          send('action', actionResult);
          
          log(`step ${step} prepared`, { pseudoCode });
        }
      }

      log('done', { totalSteps: runnerResult.results.length, successCount: runnerResult.results.filter(r => r.success).length });
      send('done', { success: true, clientType, totalSteps: runnerResult.results.length });
      close();
      resolve(runnerResult);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', msg);
      send('error', { message: msg });
      send('done', { success: false });
      close();
      reject(err);
    }
  });

  return { stream, result };
}
