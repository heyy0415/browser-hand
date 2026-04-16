/**
 * 浏览器内执行的元素提取脚本 (v2.0)
 * 供 scanner.ts 的 scanPageFromPlaywrightPage 和 scanner-worker.mjs 共同使用
 *
 * 核心改造：
 * 1. 双轨输出：domText（带空间属性给 LLM）+ elementMap（结构化坐标给算法）
 * 2. Shadow DOM 递归穿透扫描
 * 3. 空间词计算并内联为 data-pos 属性
 */

export const EXTRACTION_SCRIPT = `
(function extract() {

  // ── 空间词计算 ─────────────────────────────────
  function computeSpatialWord(rect) {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var cx = rect.x + rect.width / 2;
    var cy = rect.y + rect.height / 2;
    var xRatio = vw > 0 ? cx / vw : 0.5;
    var yRatio = vh > 0 ? cy / vh : 0.5;
    var yBucket = yRatio < 0.33 ? 'top' : yRatio < 0.66 ? 'mid' : 'bottom';
    var xBucket = xRatio < 0.33 ? 'left' : xRatio < 0.66 ? 'center' : 'right';
    return yBucket + '-' + xBucket;
  }

  // ── 选择器生成 ──────────────────────────────────
  function makeSelector(el, root) {
    // root 用于唯一性校验的作用域，默认 document
    var scope = root || document;

    // 1. ID
    if (el.id) return '#' + CSS.escape(el.id);

    // 2. data-testid
    var testId = el.getAttribute('data-testid');
    if (testId) return '[data-testid="' + testId + '"]';

    // 3. name
    var name = el.getAttribute('name');
    if (name) {
      var sel = el.tagName.toLowerCase() + '[name="' + name + '"]';
      try { if (scope.querySelectorAll(sel).length === 1) return sel; } catch(e) {}
    }

    // 4. aria-label
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return el.tagName.toLowerCase() + '[aria-label="' + ariaLabel + '"]';

    // 5. 唯一 class 组合（在当前 root 作用域内校验唯一性）
    if (typeof el.className === 'string' && el.className.trim()) {
      var cls = el.className.trim().split(/\\s+/).filter(Boolean);
      if (cls.length > 0) {
        var classSel = '.' + cls.map(function(c) { return CSS.escape(c); }).join('.');
        try { if (scope.querySelectorAll(classSel).length === 1) return classSel; } catch(e) {}
      }
    }

    // 6. 唯一文本 (links / buttons)
    if (['A','BUTTON','SPAN'].indexOf(el.tagName) !== -1) {
      var txt = (el.textContent || '').trim().replace(/\\s+/g, ' ');
      if (txt.length > 0 && txt.length <= 40) {
        var escaped = txt.replace(/"/g, '\\\\\\"');
        var tagSel = el.tagName.toLowerCase() + ':has-text("' + escaped + '")';
        try {
          var candidates = scope.querySelectorAll(el.tagName.toLowerCase());
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

    // 7. nth-of-type 路径 (兜底，不穿透 Shadow 边界)
    var node = el, parts = [];
    while (node && node !== (scope === document ? document.body : scope) && node !== document.documentElement) {
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

  // ── 宿主元素选择器生成 ─────────────────────────
  function makeHostSelector(host) {
    if (host.id) return host.tagName.toLowerCase() + '#' + CSS.escape(host.id);
    var testId = host.getAttribute('data-testid');
    if (testId) return host.tagName.toLowerCase() + '[data-testid="' + testId + '"]';

    // nth-of-type 兜底
    var parent = host.parentElement;
    if (parent) {
      var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === host.tagName; });
      if (siblings.length > 1) {
        return host.tagName.toLowerCase() + ':nth-of-type(' + (siblings.indexOf(host) + 1) + ')';
      }
    }
    return host.tagName.toLowerCase();
  }

  // ── 可见性检测（跨 Shadow 边界） ──────────────
  function isVisible(el) {
    if (el.nodeType !== 1) return false;
    var rect = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    if (rect.width === 0 && rect.height === 0 &&
        cs.position !== 'absolute' && cs.position !== 'fixed') return false;
    // 检查当前 root 内的祖先链
    var p = el.parentElement;
    while (p) {
      if (getComputedStyle(p).display === 'none') return false;
      p = p.parentElement;
    }
    return true;
  }

  function isVisibleAcrossShadow(el) {
    if (!isVisible(el)) return false;
    // 穿透 Shadow 边界检查宿主可见性
    var root = el.getRootNode();
    if (root !== document && root.host) {
      return isVisibleAcrossShadow(root.host);
    }
    return true;
  }

  // ── 可交互性检测（跨 Shadow 边界） ────────────
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

    return false;
  }

  function isInteractiveAcrossShadow(el) {
    if (isInteractive(el)) return true;
    // 检查 Shadow 内祖先的 onclick
    var p = el.parentElement;
    while (p) {
      if (p.hasAttribute('onclick') || typeof p.onclick === 'function') return true;
      p = p.parentElement;
    }
    // 穿透到宿主检查
    var root = el.getRootNode();
    if (root !== document && root.host) {
      return isInteractiveAcrossShadow(root.host);
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

    if (tag === 'input' || tag === 'textarea') {
      var ph = el.getAttribute('placeholder');
      if (ph) return ph.trim();
    }

    if (el.id) {
      var label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label) return (label.textContent || '').trim().substring(0, 80);
    }

    var aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();

    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var ref = document.getElementById(labelledBy);
      if (ref) return (ref.textContent || '').trim().substring(0, 80);
    }

    var title = el.getAttribute('title');
    if (title) return title.trim();

    var TEXT_TAGS = ['button','a','span','div','h1','h2','h3','h4','h5','h6','p','li','td','th','label','summary'];
    if (TEXT_TAGS.indexOf(tag) !== -1) {
      var t = (el.textContent || '').trim().replace(/\\s+/g, ' ');
      if (t.length > 0 && t.length <= 80) return t;
    }

    if (tag === 'img') return el.getAttribute('alt') || '';
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
      if (['text','search','email','tel','url','password','number'].indexOf(type) !== -1) s.value = el.value;
      s.required = el.required;
    } else if (tag === 'select') {
      s.disabled = el.disabled; s.value = el.value; s.required = el.required;
    } else if (tag === 'textarea') {
      s.disabled = el.disabled; s.readOnly = el.readOnly;
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
  // 语义特征提取（保持现有逻辑）
  // ═══════════════════════════════════════════════════════════

  function detectFunctionalZone(el) {
    var tag = el.tagName.toLowerCase();
    var rect = el.getBoundingClientRect();
    var viewWidth = window.innerWidth;
    var viewHeight = window.innerHeight;

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

    if (rect.top < 100 && rect.height < 80) return 'header';
    if (rect.top > viewHeight - 150) return 'footer';
    if (rect.left < 50 && rect.width < 300 && rect.height > 200) return 'sidebar';
    if (rect.left > viewWidth - 300 && rect.width < 300 && rect.height > 200) return 'sidebar';

    return 'unknown';
  }

  function detectFunctionalZoneAcrossShadow(el) {
    var zone = detectFunctionalZone(el);
    if (zone !== 'unknown') return zone;
    var root = el.getRootNode();
    if (root !== document && root.host) {
      return detectFunctionalZoneAcrossShadow(root.host);
    }
    return 'unknown';
  }

  function inferInteractionHint(el) {
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute('type') || '').toLowerCase();
    var role = el.getAttribute('role') || '';
    var label = (el.getAttribute('aria-label') || el.textContent || '').toLowerCase();
    var classStr = (el.className || '').toLowerCase();

    if (type === 'submit' || /\\b(submit|confirm|save|ok|确定|提交|保存)\\b/.test(label + ' ' + classStr)) return 'submit';
    if (/\\b(cancel|close|dismiss|back|取消|关闭|返回)\\b/.test(label + ' ' + classStr)) return 'cancel';
    if (tag === 'a' && el.getAttribute('href') && !el.getAttribute('href').startsWith('#')) return 'navigation';
    if (['input', 'textarea'].indexOf(tag) !== -1 && !['submit', 'button', 'reset'].includes(type)) return 'input';
    if (tag === 'select' || ['checkbox', 'radio'].indexOf(type) !== -1 || ['checkbox', 'radio', 'combobox', 'listbox'].indexOf(role) !== -1) return 'selection';
    if (['switch', 'toggle'].indexOf(role) !== -1 || /\\b(toggle|switch)\\b/.test(classStr)) return 'toggle';
    return 'action';
  }

  function generateEmbeddingText(el, role, label, zone, interactionHint) {
    var parts = [];
    if (label) parts.push(label);
    var rawText = (el.textContent || '').trim().replace(/\\s+/g, ' ').substring(0, 100);
    if (rawText && rawText !== label) parts.push(rawText);
    parts.push(el.tagName.toLowerCase() + ' ' + role);
    if (zone && zone !== 'unknown') parts.push(zone + '区域');
    if (interactionHint) parts.push(interactionHint);

    var classStr = (el.className || '').toLowerCase();
    var semanticPatterns = [
      { pattern: /search|搜索/gi, label: '搜索' },
      { pattern: /submit|提交/gi, label: '提交' },
      { pattern: /login|登录/gi, label: '登录' },
      { pattern: /btn|button/gi, label: '按钮' },
      { pattern: /input|输入/gi, label: '输入' },
      { pattern: /nav|导航/gi, label: '导航' },
      { pattern: /form|表单/gi, label: '表单' },
    ];
    for (var i = 0; i < semanticPatterns.length; i++) {
      if (semanticPatterns[i].pattern.test(classStr + ' ' + (el.getAttribute('name') || '')) && parts.indexOf(semanticPatterns[i].label) === -1) {
        parts.push(semanticPatterns[i].label);
      }
    }
    return parts.join(' ');
  }

  // ═══════════════════════════════════════════════════════════
  // v2.0 核心：递归穿透扫描 + 双轨输出
  // ═══════════════════════════════════════════════════════════

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
  var elementEntries = []; // { element, shadowHostChain }
  var closedShadowHosts = []; // closed shadow DOM 的宿主元素

  // 递归扫描 Shadow DOM
  function scanShadowRoots(root, shadowHostChain) {
    for (var si = 0; si < SELECTORS.length; si++) {
      var nodes;
      try { nodes = root.querySelectorAll(SELECTORS[si]); } catch(e) { continue; }
      for (var ni = 0; ni < nodes.length; ni++) {
        var el = nodes[ni];
        if (seen.has(el)) continue;
        seen.add(el);
        if (!isVisibleAcrossShadow(el)) continue;
        if (!isInteractiveAcrossShadow(el)) continue;
        elementEntries.push({ element: el, shadowHostChain: shadowHostChain.slice() });
      }
    }

    // 递归穿透 Open Shadow Root
    var allElements = root.querySelectorAll('*');
    for (var ei = 0; ei < allElements.length; ei++) {
      var host = allElements[ei];
      if (host.shadowRoot) {
        var hostSelector = makeHostSelector(host);
        var newChain = shadowHostChain.concat([hostSelector]);
        scanShadowRoots(host.shadowRoot, newChain);
      }
      // 检测 Closed Shadow DOM
      if (!host.shadowRoot && host.attachShadow && typeof host.attachShadow === 'function') {
        // 启发式：自定义元素（含连字符的标签名）且不可访问 shadowRoot，可能是 closed
        if (host.tagName.indexOf('-') !== -1) {
          closedShadowHosts.push(host);
        }
      }
    }
  }

  scanShadowRoots(document, []);

  // ═══════════════════════════════════════════════════════════
  // 双轨输出构建
  // ═══════════════════════════════════════════════════════════

  var domTextLines = [];
  var elementMap = {};
  var vw = window.innerWidth;
  var vh = window.innerHeight;

  for (var idx = 0; idx < elementEntries.length; idx++) {
    var entry = elementEntries[idx];
    var el = entry.element;
    var chain = entry.shadowHostChain;

    var rect = el.getBoundingClientRect();
    var role = getRole(el);
    var label = getLabel(el);
    var zone = detectFunctionalZoneAcrossShadow(el);
    var interactionHint = inferInteractionHint(el);
    var spatialWord = computeSpatialWord(rect);
    var rawText = (el.textContent || '').trim().replace(/\\s+/g, ' ').substring(0, 120);
    var embeddingText = generateEmbeddingText(el, role, label, zone, interactionHint);

    // 穿透选择器
    var localSelector = makeSelector(el, el.getRootNode());
    var fullSelector = chain.length > 0
      ? chain.join(' >>> ') + ' >>> ' + localSelector
      : localSelector;

    // domText 行
    var tag = el.tagName.toLowerCase();
    var line = '[' + idx + '] <' + tag;
    // 添加关键属性到 domText
    var placeholder = el.getAttribute('placeholder');
    if (placeholder) line += ' placeholder="' + placeholder + '"';
    var href = el.getAttribute('href');
    if (href && tag === 'a') line += ' href="' + href.substring(0, 80) + '"';
    line += ' data-zone="' + zone + '"';
    line += ' data-pos="' + spatialWord + '"';
    if (chain.length > 0) {
      line += ' data-shadow="' + chain.join('>') + '"';
    }
    line += '>';
    if (label && tag !== 'input' && tag !== 'textarea') line += label.substring(0, 50);
    else if (rawText && ['button','a','span'].indexOf(tag) !== -1) line += rawText.substring(0, 50);
    line += '</' + tag + '>';

    domTextLines.push(line);

    // elementMap 条目
    var centerY = rect.y + rect.height / 2;
    var yRatio = vh > 0 ? centerY / vh : 0.5;
    elementMap[idx] = {
      selector: fullSelector,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height), centerY: Math.round(centerY), yRatio: Math.round(yRatio * 1000) / 1000 },
      zone: zone,
      role: role,
      rawText: rawText,
      embeddingText: embeddingText,
    };
    if (chain.length > 0) {
      elementMap[idx].shadowHosts = chain.slice();
    }
  }

  // ── Closed Shadow DOM 标记 ──
  for (var ci = 0; ci < closedShadowHosts.length; ci++) {
    var cHost = closedShadowHosts[ci];
    var cRect = cHost.getBoundingClientRect();
    var cSpatial = computeSpatialWord(cRect);
    var cIdx = elementEntries.length + ci;
    domTextLines.push('[' + cIdx + '] <' + cHost.tagName.toLowerCase() + ' data-zone="' + detectFunctionalZone(cHost) + '" data-pos="' + cSpatial + '" data-closed-shadow="true">' + (cHost.textContent || '').trim().substring(0, 50) + '</' + cHost.tagName.toLowerCase() + '>');
    // closed shadow host 不加入 elementMap（无法操作其内部元素）
  }

  // ── 区域包围盒计算 ──
  var zonesBoundingBox = {};
  for (var zi = 0; zi < elementEntries.length; zi++) {
    var eZone = elementMap[zi].zone || 'unknown';
    if (!zonesBoundingBox[eZone]) {
      zonesBoundingBox[eZone] = { x: Infinity, y: Infinity, x2: -Infinity, y2: -Infinity };
    }
    var zr = elementMap[zi].rect;
    zonesBoundingBox[eZone].x = Math.min(zonesBoundingBox[eZone].x, zr.x);
    zonesBoundingBox[eZone].y = Math.min(zonesBoundingBox[eZone].y, zr.y);
    zonesBoundingBox[eZone].x2 = Math.max(zonesBoundingBox[eZone].x2, zr.x + zr.w);
    zonesBoundingBox[eZone].y2 = Math.max(zonesBoundingBox[eZone].y2, zr.y + zr.h);
  }
  for (var zn in zonesBoundingBox) {
    var bb = zonesBoundingBox[zn];
    zonesBoundingBox[zn] = { x: bb.x, y: bb.y, width: bb.x2 - bb.x, height: bb.y2 - bb.y };
  }

  // ── 可见文本扫描 ──
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

  return {
    domText: domTextLines.join('\\n'),
    elementMap: elementMap,
    totalElements: elementEntries.length,
    visibleText: visibleText,
    zonesBoundingBox: zonesBoundingBox
  };
})();
`;
