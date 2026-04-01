#!/usr/bin/env node
/**
 * Playwright 扫描 Worker
 * 由 Bun scanner 层通过 child_process.spawn 调用
 *
 * 通信协议：
 *   - 进度:  stdout 逐行输出 JSON {"type":"progress","data":"..."}
 *   - 结果:  stdout 输出 JSON {"type":"result","data":{...}}
 *   - 错误:  stderr 输出文本
 */

import { chromium } from 'playwright';

// ── CLI 参数 ─────────────────────────────────────────────────────

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) {
    args[process.argv[i].slice(2)] = process.argv[i + 1];
    i++;
  }
}

const URL = args.url;
const PAGE_ID = args.pageId || 'p0';
const TIMEOUT = parseInt(args.timeout || '30000', 10);
const AUTO_SCROLL = args.autoScroll !== 'false';

if (!URL) {
  process.stderr.write('Missing --url\n');
  process.exit(1);
}

// ── 工具函数 ─────────────────────────────────────────────────────

function log(type, data) {
  process.stdout.write(JSON.stringify({ type, data }) + '\n');
}

function err(msg) {
  process.stderr.write(msg + '\n');
}

// ── 浏览器内执行的提取代码 ────────────────────────────────────────

const EXTRACTION_SCRIPT = `
(function extract() {

  // ── 选择器生成 ──────────────────────────────────
  function makeSelector(el) {
    // 1. ID
    if (el.id) return '#' + CSS.escape(el.id);

    // 2. data-testid
    var testId = el.getAttribute('data-testid');
    if (testId) return '[data-testid="' + testId + '"]';

    // 3. name
    var name = el.getAttribute('name');
    if (name) {
      var sel = el.tagName.toLowerCase() + '[name="' + name + '"]';
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch(e) {}
    }

    // 4. aria-label
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return el.tagName.toLowerCase() + '[aria-label="' + ariaLabel + '"]';

    // 5. 唯一 class 组合
    if (typeof el.className === 'string' && el.className.trim()) {
      var cls = el.className.trim().split(/\\s+/).filter(Boolean);
      if (cls.length > 0) {
        var classSel = '.' + cls.map(function(c) { return CSS.escape(c); }).join('.');
        try { if (document.querySelectorAll(classSel).length === 1) return classSel; } catch(e) {}
      }
    }

    // 6. 唯一文本 (links / buttons)
    if (['A','BUTTON','SPAN'].indexOf(el.tagName) !== -1) {
      var txt = (el.textContent || '').trim().replace(/\\s+/g, ' ');
      if (txt.length > 0 && txt.length <= 40) {
        var escaped = txt.replace(/"/g, '\\\\\\"');
        var tagSel = el.tagName.toLowerCase() + ':has-text("' + escaped + '")';
        try {
          var candidates = document.querySelectorAll(el.tagName.toLowerCase());
          var unique = true;
          for (var ci = 0; ci < candidates.length; ci++) {
            if (candidates[ci] !== el &&
                (candidates[ci].textContent || '').trim().replace(/\\s+/g, ' ') === txt) {
              unique = false; break;
            }
          }
          if (unique) return tagSel;
        } catch(e) {}
      }
    }

    // 7. nth-of-type 路径 (兜底)
    var node = el, parts = [];
    while (node && node !== document.body && node !== document.documentElement) {
      var tag = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (parent) {
        var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === node.tagName; });
        if (siblings.length > 1) {
          parts.unshift(tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')');
        } else {
          parts.unshift(tag);
        }
      } else {
        parts.unshift(tag);
      }
      node = parent;
    }
    return parts.join(' > ');
  }

  // ── 可见性检测 ─────────────────────────────────
  function isVisible(el) {
    if (el.nodeType !== 1) return false;
    var rect = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    if (rect.width === 0 && rect.height === 0 &&
        cs.position !== 'absolute' && cs.position !== 'fixed') return false;
    var p = el.parentElement;
    while (p) {
      if (getComputedStyle(p).display === 'none') return false;
      p = p.parentElement;
    }
    return true;
  }

  // ── 可交互性检测 ───────────────────────────────
  function isInteractive(el) {
    var tag = el.tagName.toLowerCase();
    var INTERACTIVE = [
      'a','button','input','textarea','select','details','summary',
      'video','audio','embed','object','iframe','canvas',
    ];
    if (INTERACTIVE.indexOf(tag) !== -1) return true;

    var role = el.getAttribute('role');
    if (role && /^(button|link|textbox|checkbox|radio|switch|tab|menuitem|slider|combobox|searchbox|option|treeitem)/.test(role))
      return true;

    if (el.contentEditable === 'true') return true;
    if (typeof el.onclick === 'function') return true;
    if (el.hasAttribute('onclick')) return true;
    if (getComputedStyle(el).cursor === 'pointer') return true;

    // 祖先有 onclick
    var p = el;
    while (p && p !== document.body) {
      if (p.hasAttribute('onclick') || typeof p.onclick === 'function') return true;
      p = p.parentElement;
    }

    return false;
  }

  // ── Role 推断 ─────────────────────────────────
  function getRole(el) {
    var tag = el.tagName.toLowerCase();
    var aria = el.getAttribute('role');
    if (aria) return aria;

    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'canvas') return 'canvas';
    if (tag === 'video') return 'video';
    if (tag === 'audio') return 'audio';
    if (tag === 'iframe') return 'iframe';
    if (tag === 'details') return 'details';

    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      var map = {
        checkbox: 'checkbox', radio: 'radio', file: 'file-upload',
        date: 'date-picker', 'datetime-local': 'date-picker',
        range: 'range-slider', color: 'color-picker',
        submit: 'button', reset: 'button', button: 'button',
        search: 'searchbox', email: 'text-input', tel: 'text-input',
        url: 'text-input', password: 'text-input', number: 'text-input',
        text: 'text-input',
      };
      return map[type] || 'text-input';
    }

    if (el.contentEditable === 'true') return 'content-editable';
    return 'clickable';
  }

  // ── Label 提取 ────────────────────────────────
  function getLabel(el) {
    var tag = el.tagName.toLowerCase();

    // placeholder
    if (tag === 'input' || tag === 'textarea') {
      var ph = el.getAttribute('placeholder');
      if (ph) return ph.trim();
    }

    // <label for="...">
    if (el.id) {
      var label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label) return (label.textContent || '').trim().substring(0, 80);
    }

    // aria-label
    var aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();

    // aria-labelledby
    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var ref = document.getElementById(labelledBy);
      if (ref) return (ref.textContent || '').trim().substring(0, 80);
    }

    // title
    var title = el.getAttribute('title');
    if (title) return title.trim();

    // 文本内容
    var TEXT_TAGS = ['button','a','span','div','h1','h2','h3','h4','h5','h6','p','li','td','th','label','summary'];
    if (TEXT_TAGS.indexOf(tag) !== -1) {
      var t = (el.textContent || '').trim().replace(/\\s+/g, ' ');
      if (t.length > 0 && t.length <= 80) return t;
    }

    // img alt
    if (tag === 'img') return el.getAttribute('alt') || '';

    // input button value
    if (tag === 'input' && ['submit','reset','button'].indexOf((el.getAttribute('type')||'').toLowerCase()) !== -1) {
      return el.value || '';
    }

    return '';
  }

  // ── 状态提取 ──────────────────────────────────
  function getState(el) {
    var tag = el.tagName.toLowerCase();
    var s = {};

    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      s.type = type;
      if (type === 'checkbox' || type === 'radio') s.checked = el.checked;
      s.disabled = el.disabled;
      s.readOnly = el.readOnly;
      if (['text','search','email','tel','url','password','number'].indexOf(type) !== -1) {
        s.value = el.value;
      }
      s.required = el.required;
    } else if (tag === 'select') {
      s.disabled = el.disabled;
      s.value = el.value;
      s.required = el.required;
    } else if (tag === 'textarea') {
      s.disabled = el.disabled;
      s.readOnly = el.readOnly;
      s.value = el.value ? el.value.substring(0, 100) : '';
      s.required = el.required;
    } else if (tag === 'button') {
      s.disabled = el.disabled;
    } else if (tag === 'a') {
      s.href = el.getAttribute('href') || '';
    } else if (tag === 'details') {
      s.open = el.open;
    }

    if (el.hasAttribute('aria-expanded')) s.expanded = el.getAttribute('aria-expanded') === 'true';
    if (el.hasAttribute('aria-pressed')) s.pressed = el.getAttribute('aria-pressed') === 'true';
    if (el.hasAttribute('aria-selected')) s.selected = el.getAttribute('aria-selected') === 'true';

    return s;
  }

  // ── 主扫描（可交互元素） ─────────────────────
  var SELECTORS = [
    'a[href]', 'button', 'input', 'textarea', 'select',
    '[role="button"]', '[role="link"]', '[role="textbox"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
    '[role="tab"]', '[role="menuitem"]', '[role="combobox"]',
    '[role="slider"]', '[role="searchbox"]', '[role="option"]',
    '[onclick]', '[contenteditable="true"]',
    'details', 'summary', 'canvas', 'video', 'audio',
    'iframe', 'embed', 'object',
    'label[for]',
  ];

  var seen = new Set();
  var elements = [];

  for (var si = 0; si < SELECTORS.length; si++) {
    var nodes;
    try { nodes = document.querySelectorAll(SELECTORS[si]); } catch(e) { continue; }
    for (var ni = 0; ni < nodes.length; ni++) {
      var el = nodes[ni];
      if (seen.has(el)) continue;
      seen.add(el);
      if (!isVisible(el)) continue;
      if (!isInteractive(el)) continue;

      var rect = el.getBoundingClientRect();
      var rawText = (el.textContent || '').trim().replace(/\\s+/g, ' ');
      elements.push({
        tag: el.tagName.toLowerCase(),
        role: getRole(el),
        selector: makeSelector(el),
        label: getLabel(el),
        text: rawText.substring(0, 120),
        state: getState(el),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      });
    }
  }

  // ── 可见文本扫描（非交互元素，提供页面内容上下文） ──
  var VISIBLE_SELECTORS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote'];
  var visibleText = [];
  for (var vi = 0; vi < VISIBLE_SELECTORS.length; vi++) {
    var vnodes;
    try { vnodes = document.querySelectorAll(VISIBLE_SELECTORS[vi]); } catch(e) { continue; }
    for (var vj = 0; vj < vnodes.length; vj++) {
      var vel = vnodes[vj];
      if (seen.has(vel)) continue;
      if (!isVisible(vel)) continue;
      var vtxt = (vel.textContent || '').trim().replace(/\\s+/g, ' ');
      if (vtxt.length > 2 && vtxt.length < 300) {
        visibleText.push({
          tag: vel.tagName.toLowerCase(),
          text: vtxt.substring(0, 150),
        });
        if (visibleText.length >= 50) break;
      }
    }
    if (visibleText.length >= 50) break;
  }

  // img 元素
  var imgs;
  try { imgs = document.querySelectorAll('img'); } catch(e) { imgs = []; }
  for (var ii = 0; ii < imgs.length && visibleText.length < 50; ii++) {
    var img = imgs[ii];
    if (!isVisible(img)) continue;
    var alt = (img.getAttribute('alt') || '').trim();
    if (alt.length > 0 && alt.length < 200) {
      visibleText.push({ tag: 'img', text: alt });
    }
  }

  return { elements: elements, visibleText: visibleText };
})();
`;

// ── 主流程 ───────────────────────────────────────────────────────

(async () => {
  let browser;
  try {
    log('progress', 'launching browser');

    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'zh-CN',
    });

    const page = await context.newPage();

    // ── 导航 ──
    log('progress', `navigating to ${URL}`);
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

    // ── 等待动态渲染 ──
    log('progress', 'waiting for dynamic content');
    await page.waitForTimeout(1500);

    // ── 滚动触发懒加载 ──
    if (AUTO_SCROLL) {
      log('progress', 'scrolling to trigger lazy load');
      await page.evaluate(() => {
        return new Promise((resolve) => {
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
    }

    // ── 扫描所有帧 ──
    log('progress', 'scanning elements');
    const allElements = [];
    const allVisibleText = [];
    let globalIndex = 0;

    async function scanFrame(frame, framePath) {
      let result;
      try {
        result = await frame.evaluate(EXTRACTION_SCRIPT);
      } catch (e) {
        err(`[frame ${framePath.join('.')}]: ${e.message}`);
        return;
      }

      for (const el of (result.elements || [])) {
        allElements.push({
          uid: `${PAGE_ID}:${framePath.join(':')}:${globalIndex++}`,
          tag: el.tag,
          role: el.role,
          label: el.label,
          text: el.text || '',
          selector: el.selector,
          state: el.state,
          rect: el.rect,
          framePath: [...framePath],
        });
      }

      for (const vt of (result.visibleText || [])) {
        allVisibleText.push({ tag: vt.tag, text: vt.text });
      }

      // 递归子帧
      let children = [];
      try { children = frame.childFrames(); } catch {}
      for (let i = 0; i < children.length; i++) {
        await scanFrame(children[i], [...framePath, i]);
      }
    }

    await scanFrame(page.mainFrame(), []);

    // ── 兜底: page.frames() 补扫 ──
    const scannedSet = new Set(allElements.map((e) => e.framePath.join('.')));
    const frameList = [];

    function indexFrames(frame, path) {
      frameList.push({ frame, path });
      let children;
      try { children = frame.childFrames(); } catch { children = []; }
      for (let i = 0; i < children.length; i++) {
        indexFrames(children[i], [...path, i]);
      }
    }

    try { indexFrames(page.mainFrame(), []); } catch {}

    for (const { frame, path } of frameList) {
      if (scannedSet.has(path.join('.'))) continue;
      let result;
      try { result = await frame.evaluate(EXTRACTION_SCRIPT); } catch { continue; }
      for (const el of (result.elements || [])) {
        allElements.push({
          uid: `${PAGE_ID}:${path.join(':')}:${globalIndex++}`,
          tag: el.tag,
          role: el.role,
          label: el.label,
          text: el.text || '',
          selector: el.selector,
          state: el.state,
          rect: el.rect,
          framePath: [...path],
        });
      }
      for (const vt of (result.visibleText || [])) {
        allVisibleText.push({ tag: vt.tag, text: vt.text });
      }
    }

    // ── 输出结果 ──
    const pageTitle = await page.title().catch(() => '');
    const result = {
      url: URL,
      title: pageTitle,
      elements: allElements,
      visibleText: allVisibleText,
    };

    log('progress', `found ${allElements.length} elements`);
    log('result', result);
  } catch (e) {
    err(e.message || String(e));
    log('error', e.message || String(e));
    process.exit(1);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
})();
