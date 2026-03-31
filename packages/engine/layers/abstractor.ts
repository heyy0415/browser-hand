import { logger } from '@@browser-hand/engine-shared/util';
import type {
  VectorResult,
  AbstractorResult,
  IntentionResult,
  ElementSnapshot,
} from '@@browser-hand/engine-shared/type';

const log = (msg: string, meta?: unknown) => logger.info('abstractor', msg, meta);

function pickElement(target: string, elements: ElementSnapshot[]): ElementSnapshot | null {
  if (!target) {
    return elements[0] ?? null;
  }

  const lowerTarget = target.toLowerCase();
  for (const element of elements) {
    const hitText = `${element.label} ${element.selector} ${element.tag} ${element.role}`.toLowerCase();
    if (hitText.includes(lowerTarget)) {
      return element;
    }
  }

  return elements[0] ?? null;
}

function extractQuotedValue(desc: string): string {
  const m = desc.match(/["“”'‘’]([^"“”'‘’]+)["“”'‘’]/);
  if (m?.[1]) {
    return m[1];
  }
  return '';
}

function toPseudoCode(
  action: string,
  target: string,
  desc: string,
  picked: ElementSnapshot | null,
): string {
  const selector = picked?.selector || target;

  switch (action) {
    case 'navigate':
    case 'open':
    case 'goto':
    case 'visit':
      return `navigate('${target}')`;
    case 'click':
    case 'submit':
    case 'login':
    case 'logout':
    case 'sort':
    case 'filter':
      return `click('${selector}')`;
    case 'doubleclick':
      return `doubleClick('${selector}')`;
    case 'fill':
    case 'type':
    case 'search': {
      const value = extractQuotedValue(desc) || target;
      return `fill('${selector}', '${value}')`;
    }
    case 'select': {
      const value = extractQuotedValue(desc) || target;
      return `select('${selector}', '${value}')`;
    }
    case 'check':
      return `check('${selector}')`;
    case 'uncheck':
      return `uncheck('${selector}')`;
    case 'scroll':
      return `scrollDown()`;
    case 'screenshot':
      return `screenshot('step')`;
    case 'extract':
      return `getText('${selector}')`;
    default:
      return `click('${selector}')`;
  }
}

export async function abstract(
  intention: IntentionResult,
  vector: VectorResult,
): Promise<AbstractorResult> {
  const code: string[] = [];

  for (const step of intention.flow) {
    const picked = pickElement(step.target, vector.elements);
    code.push(toPseudoCode(step.action, step.target, step.desc, picked));
  }

  const complexity = code.length <= 2 ? 'low' : code.length <= 5 ? 'medium' : 'high';

  const result: AbstractorResult = {
    code,
    summary: code.join(' -> '),
    meta: {
      totalSteps: code.length,
      estimatedComplexity: complexity,
    },
  };

  log('done', { steps: code.length });
  return result;
}
