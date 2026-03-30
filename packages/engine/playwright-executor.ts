/**
 * Playwright 执行服务 - 在 Node.js 环境中运行
 * 用于 Web 端通过 Playwright 执行浏览器自动化任务
 */

import { chromium } from 'playwright';
import type { AbstractorResult, RunnerResult, ActionResult } from '@browser-hand/engine';

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
 * 执行伪代码列表（Web 端 - Node.js 环境）
 */
export async function executePlaywrightActions(
  abstractorResult: AbstractorResult,
): Promise<RunnerResult> {
  const browser = await chromium.launch();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  const results: ActionResult[] = [];

  try {
    const playwrightCode = pseudoCodeToPlaywright(abstractorResult.code);

    for (let i = 0; i < playwrightCode.length; i++) {
      const step = i + 1;
      try {
        // 执行单条 Playwright 代码
        // eslint-disable-next-line no-eval
        await eval(`(async () => { ${playwrightCode[i]} })()`);

        results.push({
          step,
          success: true,
          data: { code: playwrightCode[i] },
        });

        console.log(`✓ Step ${step} success`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          step,
          success: false,
          error: msg,
          data: { code: playwrightCode[i] },
        });

        console.error(`✗ Step ${step} error: ${msg}`);
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  return { results };
}

/**
 * 执行伪代码列表（Web 端 - 仅生成代码，不执行）
 */
export function generatePlaywrightCode(abstractorResult: AbstractorResult): RunnerResult {
  const playwrightCode = pseudoCodeToPlaywright(abstractorResult.code);

  const results: ActionResult[] = playwrightCode.map((code, i) => ({
    step: i + 1,
    success: true,
    data: { code },
  }));

  return { results };
}
