#!/usr/bin/env node
/**
 * Playwright Runner - 在 Node.js 环境中执行浏览器自动化
 * 由 Bun 后端通过子进程调用
 */

async function executePlaywrightCode(code) {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const context = await browser.createBrowserContext();
    const page = await context.newPage();

    try {
      // eslint-disable-next-line no-eval
      await (0, eval)(`(async () => { ${code} })()`);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      await context.close();
      await browser.close();
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// 从命令行参数读取代码
const code = process.argv[2];
if (!code) {
  console.error('Usage: playwright-runner.js "<code>"');
  process.exit(1);
}

executePlaywrightCode(code)
  .then((result) => {
    console.log(JSON.stringify(result));
    process.exit(result.success ? 0 : 1);
  })
  .catch((err) => {
    console.error(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
