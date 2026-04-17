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

  // ═══════════════════════════════════════════════════════════
  // 新增：语义特征提取
  // ═══════════════════════════════════════════════════════════

  // ── 功能区域检测 ───────────────────────────────
  function detectFunctionalZone(el) {
    var tag = el.tagName.toLowerCase();
    var rect = el.getBoundingClientRect();
    var viewWidth = window.innerWidth;
    var viewHeight = window.innerHeight;

    // 通过语义化标签检测
    var semanticParent = el.closest('nav, header, footer, main, aside, article, section, form, dialog, [role="dialog"], [role="navigation"], [role="search"], [role="main"]');
    if (semanticParent) {
      var parentTag = semanticParent.tagName.toLowerCase();
      var parentRole = semanticParent.getAttribute('role') || '';
      if (parentTag === 'nav' || parentRole === 'navigation') return 'navigation';
      if (parentTag === 'header') return 'header';
      if (parentTag === 'footer') return 'footer';
      if (parentTag === 'main' || parentRole === 'main') return 'main-content';
      if (parentTag === 'aside') return 'sidebar';
      if (parentTag === 'form' || parentRole === 'search') return 'form';
      if (parentTag === 'dialog' || parentRole === 'dialog') return 'modal';
    }

    // 通过 class/id 检测常见模式
    var classStr = (el.className || '').toLowerCase();
    var idStr = (el.id || '').toLowerCase();
    var combined = classStr + ' ' + idStr;

    if (/\\b(nav|menu|navbar|topbar|header)\\b/.test(combined)) return 'navigation';
    if (/\\b(search|searchbar|search-box)\\b/.test(combined)) return 'search';
    if (/\\b(sidebar|aside|side-nav)\\b/.test(combined)) return 'sidebar';
    if (/\\b(footer|bottom)\\b/.test(combined)) return 'footer';
    if (/\\b(modal|popup|dialog|overlay)\\b/.test(combined)) return 'modal';
    if (/\\b(form|login|register|signup)\\b/.test(combined)) return 'form';
    if (/\\b(list|items|results)\\b/.test(combined)) return 'list';
    if (/\\b(card|item|product)\\b/.test(combined)) return 'card';

    // 通过位置检测
    if (rect.top < 100 && rect.height < 80) return 'header';
    if (rect.top > viewHeight - 150) return 'footer';
    if (rect.left < 50 && rect.width < 300 && rect.height > 200) return 'sidebar';
    if (rect.left > viewWidth - 300 && rect.width < 300 && rect.height > 200) return 'sidebar';

    return 'unknown';
  }

  // ── 交互类型推断 ───────────────────────────────
  function inferInteractionHint(el) {
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute('type') || '').toLowerCase();
    var role = el.getAttribute('role') || '';
    var label = (el.getAttribute('aria-label') || el.textContent || '').toLowerCase();
    var classStr = (el.className || '').toLowerCase();

    // 提交类按钮
    if (type === 'submit' || /\\b(submit|confirm|save|ok|确定|提交|保存)\\b/.test(label + ' ' + classStr)) {
      return 'submit';
    }

    // 取消类按钮
    if (/\\b(cancel|close|dismiss|back|取消|关闭|返回)\\b/.test(label + ' ' + classStr)) {
      return 'cancel';
    }

    // 导航类
    if (tag === 'a' && el.getAttribute('href') && !el.getAttribute('href').startsWith('#')) {
      return 'navigation';
    }

    // 输入类
    if (['input', 'textarea'].indexOf(tag) !== -1 && !['submit', 'button', 'reset'].includes(type)) {
      return 'input';
    }

    // 选择类
    if (tag === 'select' || ['checkbox', 'radio'].indexOf(type) !== -1 || ['checkbox', 'radio', 'combobox', 'listbox'].indexOf(role) !== -1) {
      return 'selection';
    }

    // 切换类
    if (['switch', 'toggle'].indexOf(role) !== -1 || /\\b(toggle|switch)\\b/.test(classStr)) {
      return 'toggle';
    }

    // 默认操作
    if (tag === 'button' || role === 'button') {
      return 'action';
    }

    return 'action';
  }

  // ── 语义描述生成 ───────────────────────────────
  function generateDescription(el, role, label, interactionHint) {
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute('type') || '').toLowerCase();
    var parts = [];

    // 角色中文名
    var roleNames = {
      'button': '按钮',
      'link': '链接',
      'text-input': '输入框',
      'textarea': '文本域',
      'searchbox': '搜索框',
      'select': '下拉选择',
      'checkbox': '复选框',
      'radio': '单选框',
      'file-upload': '文件上传',
      'date-picker': '日期选择',
      'range-slider': '滑块',
      'color-picker': '颜色选择',
      'content-editable': '可编辑区域',
      'clickable': '可点击元素',
      'canvas': '画布',
      'video': '视频',
      'audio': '音频',
      'iframe': '内嵌框架',
      'details': '详情展开',
    };

    var interactionNames = {
      'submit': '提交',
      'cancel': '取消',
      'navigation': '导航',
      'input': '输入',
      'selection': '选择',
      'toggle': '切换',
      'action': '操作',
    };

    // 交互类型前缀
    if (interactionHint && interactionNames[interactionHint]) {
      parts.push(interactionNames[interactionHint]);
    }

    // 角色名称
    if (roleNames[role]) {
      parts.push(roleNames[role]);
    } else {
      parts.push(tag);
    }

    // 标签描述
    if (label && label.length > 0) {
      var shortLabel = label.substring(0, 30);
      if (interactionHint === 'input' || role === 'text-input' || role === 'textarea' || role === 'searchbox') {
        parts.push('"' + shortLabel + '"');
      } else {
        parts.push('"' + shortLabel + '"');
      }
    }

    return parts.join(' ');
  }

  // ── 父元素上下文提取 ───────────────────────────
  function getParentContext(el) {
    var parent = el.parentElement;
    if (!parent || parent === document.body) return undefined;

    var tag = parent.tagName.toLowerCase();
    var label = '';

    // 查找父元素的标签文本
    if (['FORM', 'SECTION', 'ARTICLE', 'ASIDE', 'NAV', 'HEADER', 'FOOTER', 'DIV'].indexOf(parent.tagName) !== -1) {
      var heading = parent.querySelector('h1, h2, h3, h4, h5, h6, legend, .title, .heading');
      if (heading && heading.textContent) {
        label = (heading.textContent || '').trim().substring(0, 50);
      }
    }

    // 通过 aria-label 或 title
    if (!label) {
      label = parent.getAttribute('aria-label') || parent.getAttribute('title') || '';
      label = label.trim().substring(0, 50);
    }

    if (!label) return undefined;

    return tag + (label ? ': ' + label : '');
  }

  // ── 视觉提示提取 ───────────────────────────────
  function extractVisualHints(el) {
    var hints = [];
    var classStr = (el.className || '').toLowerCase();

    // 图标类检测
    var iconPatterns = [
      { pattern: /\\b(icon|fa|glyphicon|material|mdi)\\b/, label: 'has-icon' },
      { pattern: /\\b(search|查找|搜索)\\b/, label: 'search-icon' },
      { pattern: /\\b(plus|add|添加|新增)\\b/, label: 'add-icon' },
      { pattern: /\\b(minus|remove|删除)\\b/, label: 'remove-icon' },
      { pattern: /\\b(edit|编辑|修改)\\b/, label: 'edit-icon' },
      { pattern: /\\b(heart|like|收藏|点赞)\\b/, label: 'like-icon' },
      { pattern: /\\b(share|分享)\\b/, label: 'share-icon' },
      { pattern: /\\b(cart|购物车)\\b/, label: 'cart-icon' },
      { pattern: /\\b(user|avatar|用户)\\b/, label: 'user-icon' },
      { pattern: /\\b(menu|菜单)\\b/, label: 'menu-icon' },
      { pattern: /\\b(close|删除|关闭)\\b/, label: 'close-icon' },
      { pattern: /\\b(arrow|chevron|down|up|left|right)\\b/, label: 'arrow-icon' },
    ];

    for (var i = 0; i < iconPatterns.length; i++) {
      if (iconPatterns[i].pattern.test(classStr)) {
        hints.push(iconPatterns[i].label);
        break; // 只取第一个匹配的图标提示
      }
    }

    // 检查子元素中的图标
    var iconEl = el.querySelector('i, svg, .icon, [class*="icon"]');
    if (iconEl && hints.length === 0) {
      hints.push('has-icon');
    }

    // 按钮样式检测
    var cs = getComputedStyle(el);
    if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') {
      hints.push('has-bg');
    }

    return hints.length > 0 ? hints : undefined;
  }

  // ── 表单关联 Label 提取 ────────────────────────
  function getRelatedFormLabel(el) {
    var tag = el.tagName.toLowerCase();
    if (!['input', 'textarea', 'select'].includes(tag)) return undefined;

    // 已在 getLabel 中处理的：placeholder, label[for], aria-label
    // 这里查找包裹的 label
    var parentLabel = el.closest('label');
    if (parentLabel && parentLabel !== el) {
      var text = (parentLabel.textContent || '').replace((el.value || ''), '').trim();
      if (text.length > 0 && text.length < 80) {
        return text;
      }
    }

    return undefined;
  }

  // ── 语义信息组装 ───────────────────────────────
  function extractSemantics(el, role, label) {
    var zone = detectFunctionalZone(el);
    var interactionHint = inferInteractionHint(el);
    var description = generateDescription(el, role, label, interactionHint);
    var parentContext = getParentContext(el);
    var relatedLabel = getRelatedFormLabel(el);
    var visualHints = extractVisualHints(el);

    return {
      description: description,
      zone: zone,
      parentContext: parentContext,
      relatedLabel: relatedLabel,
      visualHints: visualHints,
      interactionHint: interactionHint,
    };
  }

  // ── DOM 深度计算 ──────────────────────────────
  function computeDepth(el) {
    var d = 0, p = el.parentElement;
    while (p) { d++; p = p.parentElement; }
    return d;
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
  var domElements = [];

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
      var role = getRole(el);
      var label = getLabel(el);

      elements.push({
        tag: el.tagName.toLowerCase(),
        role: role,
        selector: makeSelector(el),
        label: label,
        text: rawText.substring(0, 120),
        state: getState(el),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        semantics: extractSemantics(el, role, label),
        depth: computeDepth(el),
      });
      domElements.push(el);
    }
  }

  // ── DOM 层级关系计算 ──────────────────────────
  var domToIdx = new Map();
  for (var di = 0; di < domElements.length; di++) {
    domToIdx.set(domElements[di], di);
  }
  for (var di = 0; di < elements.length; di++) {
    var pEl = domElements[di].parentElement;
    while (pEl && pEl !== document.body && pEl !== document.documentElement) {
      if (domToIdx.has(pEl)) {
        elements[di].parentIdx = domToIdx.get(pEl);
        break;
      }
      pEl = pEl.parentElement;
    }
  }
  domElements = []; // 释放 DOM 引用

  // ── 区域包围盒计算 ────────────────────────────
  var zonesBoundingBox = {};
  for (var zi = 0; zi < elements.length; zi++) {
    var zone = elements[zi].semantics && elements[zi].semantics.zone ? elements[zi].semantics.zone : 'unknown';
    if (!zonesBoundingBox[zone]) {
      zonesBoundingBox[zone] = { x: Infinity, y: Infinity, x2: -Infinity, y2: -Infinity };
    }
    var zr = elements[zi].rect;
    zonesBoundingBox[zone].x = Math.min(zonesBoundingBox[zone].x, zr.x);
    zonesBoundingBox[zone].y = Math.min(zonesBoundingBox[zone].y, zr.y);
    zonesBoundingBox[zone].x2 = Math.max(zonesBoundingBox[zone].x2, zr.x + zr.width);
    zonesBoundingBox[zone].y2 = Math.max(zonesBoundingBox[zone].y2, zr.y + zr.height);
  }
  for (var zn in zonesBoundingBox) {
    var bb = zonesBoundingBox[zn];
    zonesBoundingBox[zn] = { x: bb.x, y: bb.y, width: bb.x2 - bb.x, height: bb.y2 - bb.y };
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
        var vrect = vel.getBoundingClientRect();
        visibleText.push({
          tag: vel.tagName.toLowerCase(),
          text: vtxt.substring(0, 150),
          rect: { x: Math.round(vrect.x), y: Math.round(vrect.y), width: Math.round(vrect.width), height: Math.round(vrect.height) },
          zone: detectFunctionalZone(vel),
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
      var irect = img.getBoundingClientRect();
      visibleText.push({ tag: 'img', text: alt, rect: { x: Math.round(irect.x), y: Math.round(irect.y), width: Math.round(irect.width), height: Math.round(irect.height) }, zone: detectFunctionalZone(img) });
    }
  }

  return { elements: elements, visibleText: visibleText, zonesBoundingBox: zonesBoundingBox };
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
    const allZonesBoundingBox = {};
    let globalIndex = 0;

    async function scanFrame(frame, framePath) {
      let result;
      try {
        result = await frame.evaluate(EXTRACTION_SCRIPT);
      } catch (e) {
        err(`[frame ${framePath.join('.')}]: ${e.message}`);
        return;
      }

      // 记录本帧元素起始索引，用于 parentIdx → parentUid 映射
      const frameStartIdx = allElements.length;

      for (const el of (result.elements || [])) {
        const uid = `${PAGE_ID}:${framePath.join(':')}:${globalIndex++}`;
        allElements.push({
          uid,
          tag: el.tag,
          role: el.role,
          label: el.label,
          text: el.text || '',
          selector: el.selector,
          state: el.state,
          rect: el.rect,
          framePath: [...framePath],
          depth: el.depth,
          semantics: el.semantics,
          parentLocalIdx: el.parentIdx,
          frameStartIdx,
        });
      }

      for (const vt of (result.visibleText || [])) {
        allVisibleText.push({ tag: vt.tag, text: vt.text, rect: vt.rect, zone: vt.zone });
      }

      // 合并 zonesBoundingBox
      if (result.zonesBoundingBox) {
        for (const [zone, bb] of Object.entries(result.zonesBoundingBox)) {
          if (!allZonesBoundingBox[zone]) {
            allZonesBoundingBox[zone] = bb;
          } else {
            const existing = allZonesBoundingBox[zone];
            const x2 = Math.max(existing.x + existing.width, (bb).x + (bb).width);
            const y2 = Math.max(existing.y + existing.height, (bb).y + (bb).height);
            existing.x = Math.min(existing.x, (bb).x);
            existing.y = Math.min(existing.y, (bb).y);
            existing.width = x2 - existing.x;
            existing.height = y2 - existing.y;
          }
        }
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
      const frameStartIdx = allElements.length;
      for (const el of (result.elements || [])) {
        const uid = `${PAGE_ID}:${path.join(':')}:${globalIndex++}`;
        allElements.push({
          uid,
          tag: el.tag,
          role: el.role,
          label: el.label,
          text: el.text || '',
          selector: el.selector,
          state: el.state,
          rect: el.rect,
          framePath: [...path],
          depth: el.depth,
          semantics: el.semantics,
          parentLocalIdx: el.parentIdx,
          frameStartIdx,
        });
      }
      for (const vt of (result.visibleText || [])) {
        allVisibleText.push({ tag: vt.tag, text: vt.text, rect: vt.rect, zone: vt.zone });
      }
      // 合并 zonesBoundingBox
      if (result.zonesBoundingBox) {
        for (const [zone, bb] of Object.entries(result.zonesBoundingBox)) {
          if (!allZonesBoundingBox[zone]) {
            allZonesBoundingBox[zone] = bb;
          } else {
            const existing = allZonesBoundingBox[zone];
            const x2 = Math.max(existing.x + existing.width, (bb).x + (bb).width);
            const y2 = Math.max(existing.y + existing.height, (bb).y + (bb).height);
            existing.x = Math.min(existing.x, (bb).x);
            existing.y = Math.min(existing.y, (bb).y);
            existing.width = x2 - existing.x;
            existing.height = y2 - existing.y;
          }
        }
      }
    }

    // ── 解析 parentLocalIdx → parentUid，计算 childrenUids ──
    for (let i = 0; i < allElements.length; i++) {
      const el = allElements[i];
      const localIdx = el.parentLocalIdx;
      if (localIdx !== undefined && localIdx !== null) {
        const parentUid = allElements[el.frameStartIdx + localIdx]?.uid || null;
        el.parentUid = parentUid;
        // 在父元素中注册 childrenUid
        if (parentUid) {
          const parentEl = allElements[el.frameStartIdx + localIdx];
          if (parentEl) {
            if (!parentEl.childrenUids) parentEl.childrenUids = [];
            parentEl.childrenUids.push(el.uid);
          }
        }
      } else {
        el.parentUid = null;
      }
      // 清理临时字段
      delete el.parentLocalIdx;
      delete el.frameStartIdx;
    }
    // 为没有 childrenUids 的元素补空数组
    for (let i = 0; i < allElements.length; i++) {
      if (!allElements[i].childrenUids) allElements[i].childrenUids = [];
    }

    // ── 输出结果 ──
    const pageTitle = await page.title().catch(() => '');
    const result = {
      url: URL,
      title: pageTitle,
      elements: allElements,
      visibleText: allVisibleText,
      zonesBoundingBox: allZonesBoundingBox,
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
