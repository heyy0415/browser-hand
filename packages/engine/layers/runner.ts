/** runner 层 — 将 abstractor 伪代码转 Playwright 执行 */

import { chromium } from 'playwright';
import { logger } from '@@browser-hand/engine-shared/util';
import type {
  AbstractorResult,
  VectorResult,
  RunnerResult,
  RunnerOptions,
  ActionResult,
  ActionResultType,
} from '@@browser-hand/engine-shared/type';

const log = (msg: string, meta?: unknown) => logger.info('runner', msg, meta);

type ParsedPseudo = {
  method: string;
  args: string[];
};

function parsePseudo(line: string): ParsedPseudo {
  const m = line.match(/^([a-zA-Z][a-zA-Z0-9]*)\((.*)\)$/);
  if (!m) {
    return { method: 'click', args: [line] };
  }

  const method = m[1];
  const rawArgs = m[2].trim();
  if (!rawArgs) {
    return { method, args: [] };
  }

  const args: string[] = [];
  const re = /'([^']*)'|"([^"]*)"/g;
  for (const hit of rawArgs.matchAll(re)) {
    args.push(hit[1] ?? hit[2] ?? '');
  }

  return { method, args };
}

function resolveActionType(method: string): ActionResultType {
  if (method === 'navigate') return 'navigate';
  if (method === 'fill') return 'fill';
  if (method === 'select') return 'select';
  if (method === 'check' || method === 'uncheck') return 'check';
  if (method === 'scrollDown' || method === 'scrollUp') return 'scroll';
  if (method === 'screenshot') return 'screenshot';
  if (method === 'getText') return 'extract';
  return 'click';
}

export async function run(
  targetUrl: string,
  abstractor: AbstractorResult,
  vector: VectorResult,
  options: RunnerOptions = {},
): Promise<RunnerResult> {
  const stepDelay = options.stepDelay ?? 500;
  const actionTimeout = options.actionTimeout ?? 10_000;
  const headless = options.headless ?? true;

  const results: ActionResult[] = [];
  const start = Date.now();
  let success = true;

  log('start', { url: targetUrl, steps: abstractor.code.length, headless });

  const browser = await chromium.launch({ headless });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(actionTimeout);

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

    for (let i = 0; i < abstractor.code.length; i++) {
      const codeLine = abstractor.code[i];
      const { method, args } = parsePseudo(codeLine);

      try {
        switch (method) {
          case 'navigate':
            await page.goto(args[0], { waitUntil: 'domcontentloaded' });
            break;
          case 'click':
            await page.click(args[0]);
            break;
          case 'doubleClick':
            await page.dblclick(args[0]);
            break;
          case 'fill':
            await page.fill(args[0], args[1] ?? '');
            break;
          case 'select':
            await page.selectOption(args[0], { label: args[1] ?? '' });
            break;
          case 'check':
            await page.check(args[0]);
            break;
          case 'uncheck':
            await page.uncheck(args[0]);
            break;
          case 'scrollDown':
            await page.mouse.wheel(0, 800);
            break;
          case 'scrollUp':
            await page.mouse.wheel(0, -800);
            break;
          case 'screenshot':
            await page.screenshot({ fullPage: true });
            break;
          case 'getText':
            await page.textContent(args[0]);
            break;
          default:
            await page.click(args[0]);
            break;
        }

        results.push({
          step: i + 1,
          success: true,
          data: {
            type: resolveActionType(method),
            code: codeLine,
            pseudoCode: codeLine,
            target: vector.elements[0]
              ? {
                  uid: vector.elements[0].uid,
                  selector: vector.elements[0].selector,
                  tag: vector.elements[0].tag,
                  role: vector.elements[0].role,
                }
              : undefined,
          },
        });

        if (i < abstractor.code.length - 1) {
          await page.waitForTimeout(stepDelay);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        success = false;

        results.push({
          step: i + 1,
          success: false,
          error: message,
          data: {
            type: resolveActionType(method),
            code: codeLine,
            pseudoCode: codeLine,
          },
        });

        break;
      }
    }

    await context.close();
  } finally {
    await browser.close();
  }

  const duration = Date.now() - start;
  log('done', { success, steps: results.length, duration });

  return {
    results,
    success,
    duration,
  };
}
