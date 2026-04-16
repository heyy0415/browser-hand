# Browser Hand

**自然语言驱动的浏览器自动化 — 用一句话操控网页**

Browser Hand 是一个基于五层架构的浏览器自动化引擎。用户只需输入自然语言指令（如"帮我打开百度，获取热搜第一条"），系统即可自动完成意图解析、页面扫描、元素定位、伪代码生成与执行，全程通过 SSE 实时反馈进度。

---

## 核心思想

传统浏览器自动化依赖硬编码选择器，脆弱且不可扩展。Browser Hand 的核心理念是：**让浏览器理解语义，而非让开发者编写选择器**。

为此，我们设计了五层递进式流水线，将自然语言逐步转化为可执行的浏览器操作：

```
用户输入: "帮我打开百度，获取热搜的第一条"
    │
    ▼
┌───────────┐
│ Intention  │  意图解析 — 将自然语言解析为结构化操作计划
└─────┬─────┘
      │ OperationPlan
      ▼
┌───────────┐
│ Scanner    │  页面扫描 — 采集页面上所有可见元素的六维信息
└─────┬─────┘
      │ PageSnapshot
      ▼
┌───────────┐
│ Vector     │  向量过滤 — 语义匹配 + 位置匹配，精准定位目标元素
└─────┬─────┘
      │ FilteredSnapshot
      ▼
┌───────────┐
│ Abstractor │  伪代码生成 — 将匹配结果组合为可执行的伪代码
└─────┬─────┘
      │ PseudoCode
      ▼
┌───────────┐
│ Runner     │  执行引擎 — 逐行解析伪代码，调用 Playwright 执行
└───────────┘
```

每一层各司其职，层间通过内部函数调用传递完整数据，同时通过 SSE 向前端推送轻量级事件摘要，实现实时可视化。

---

## 架构概览

```
browser-hand/
├── packages/core/          # @browser-hand/core — 核心五层引擎
│   ├── pipeline.ts         #   多轮流水线编排
│   ├── llm.ts              #   LLM 客户端 + SSE 流
│   ├── constants.ts        #   Prompt 模板 + 配置
│   ├── types.ts            #   全局类型定义
│   ├── browser-registry.ts #   浏览器会话池
│   └── layers/
│       ├── intention.ts    #   Layer 1: 意图解析
│       ├── scanner.ts      #   Layer 2: 页面扫描
│       ├── scanner-extraction-script.ts  #   浏览器端元素提取脚本
│       ├── scanner-worker.mjs            #   Scanner 子进程 Worker
│       ├── vector.ts       #   Layer 3: 向量过滤
│       ├── abstractor.ts   #   Layer 4: 伪代码生成
│       └── runner.ts       #   Layer 5: 执行引擎
├── apps/server/            # @browser-hand/server — Hono HTTP 服务
│   └── src/index.ts        #   POST /api/task (SSE)
└── apps/web/               # @browser-hand/web — React 前端
    └── src/
        ├── components/     #   聊天界面、管线进度条、时间线
        ├── hooks/          #   SSE 事件处理（多轮累积）
        └── services/       #   API 调用
```

**技术栈**: Bun · TypeScript · React 19 · Hono · Playwright · OpenAI API (Qwen) · @xenova/transformers (本地向量模型)

---

## 五层架构技术实现详解

### Layer 1: Intention — 意图解析

将用户的自然语言输入转化为结构化的操作计划（`FlowStep[]`）。

#### 解析流程

```
用户输入 → LLM 流式推理 → <thinking>校验清单 → JSON 输出 → Zod 校验 → IntentionResult
                                     ↓ 失败
                              重试（最多 2 次）→ 正则兜底 → out_of_scope
```

1. **LLM 主路径**：构造 System Prompt + User Prompt 消息序列，流式调用 LLM，提取 `<thinking>...</thinking>` 内的推理过程展示给用户，解析 `</thinking>` 后的 JSON 输出
2. **Zod 严格校验**：使用 `IntentionResultSchema` 对 LLM 输出进行严格校验（`action` 枚举、`status` 枚举、`elementHint` 结构等），校验失败时将错误信息追加到对话上下文进行重试
3. **正则兜底**：LLM 连续 2 次失败后，使用 `regexFallback` 匹配 "打开/进入/访问 + 站名" 模式，通过 `DOMAIN_MAP`（百度/淘宝/京东/Google/GitHub/知乎/抖音/微博/B站）映射为 navigate 操作

#### 三种输出状态

| 状态 | 含义 | 示例 |
|------|------|------|
| `success` | 成功解析，返回 `flow: FlowStep[]` | "打开百度搜索手机" → navigate + fill + click |
| `clarification_needed` | 歧义需要澄清，返回 `question: string[]` | "搜索手机" → ["淘宝", "京东", "拼多多"] |
| `out_of_scope` | 非浏览器操作，返回 `reply: string` | "今天天气怎么样" → 拒绝执行 |

#### FlowStep 结构

每个操作步骤包含：

```typescript
interface FlowStep {
  action: ActionType;        // 10 种：navigate/fill/click/select/check/uncheck/scroll/wait/extract/screenshot
  target: string;            // 目标描述或 URL
  targetType: string;        // 'url' | 'element-description' | 'selector' | 'position'
  desc: string;              // 操作描述
  value?: string;            // fill/select 的输入值
  elementHint: ElementHint;  // 元素特征提示
  positionalHint?: PositionalHint; // 位置提示
  expectedOutcome?: string;  // 预期结果
}
```

**ElementHint** — Intention 层推断的元素特征，供后续 Vector/Abstractor 使用：

| 字段 | 说明 | 示例 |
|------|------|------|
| `interactionHint` | 交互类型（7 种） | input/submit/cancel/selection/navigation/toggle/action |
| `zoneHint` | 页面区域 | search/trending/main-content/modal 等 |
| `roleHint` | 语义角色 | textbox/button/link/listbox 等 |
| `keywords` | 关键词 | ["搜索", "kw"] |

**PositionalHint** — 位置指示，解决"第几条""最右边"等空间描述：

| 字段 | 说明 | 示例 |
|------|------|------|
| `ordinal` | 序号（正=从头数，负=从尾数） | 1=第一条, -1=最后一条 |
| `direction` | 方向（8 方向） | top/bottom/left/right 及对角 |
| `scope` | 作用域 | sibling/zone/viewport/nearby |
| `referenceTarget` | 参照物 | "搜索按钮的右边" |

#### 关键规则

- **"搜索" 不作为独立 action**：搜索必须拆解为 `fill + click`（填写搜索词 + 点击搜索按钮）
- **五项校验清单**：LLM 推理时必须依次完成 — 平台判定 → 操作拆解 → 位置提取 → 上下文校验 → flow 步数
- **elementHint 算法推断表**：Prompt 内嵌推断规则，根据意图自动推断交互类型、区域、角色、关键词，为 Vector 层提供精确约束

---

### Layer 2: Scanner — 页面扫描

通过 Playwright 注入脚本，采集页面上所有可见元素的六维结构化信息，生成 `PageSnapshot`。

#### 六维信息模型

每个元素（`ElementSnapshot`）采集以下六个维度：

| 维度 | 字段 | 说明 |
|------|------|------|
| **身份** | uid, tag, selector | 唯一标识、标签名、CSS 选择器 |
| **语义角色** | role | 18 种语义角色（link/button/text-input/checkbox 等） |
| **标签文本** | label, text | 人类可读名称、内容文本（≤120 字） |
| **空间几何** | rect, depth | {x, y, width, height}、DOM 深度 |
| **交互状态** | state | checked/disabled/value/href/open/expanded/pressed/selected |
| **语义上下文** | semantics | description/zone/parentContext/relatedLabel/visualHints/interactionHint |

#### 选择器生成策略

`makeSelector` 采用 7 级优先级级联，生成最稳定且唯一的 CSS 选择器：

| 优先级 | 策略 | 示例 |
|--------|------|------|
| 1 | ID 选择器 | `#kw` |
| 2 | data-testid | `[data-testid="search-input"]` |
| 3 | name 属性 | `input[name="wd"]` |
| 4 | aria-label | `input[aria-label="搜索"]` |
| 5 | class 组合 | `.search-form .input` |
| 6 | 文本匹配 | `a:has-text("登录")` |
| 7 | 结构路径兜底 | `div > span:nth-of-type(2)` |

#### 功能区域检测

`detectFunctionalZone` 三级检测策略：

1. **语义化父标签**：`<nav>` → navigation, `<header>` → header, `<main>` → main-content, `<aside>` → sidebar, `<form>` → form, `<dialog>` → modal
2. **class/ID 模式匹配**：正则匹配 nav/search/sidebar/footer/modal/form/list/card/trending 等关键词
3. **位置启发式**：顶部 y < 100 → header, 底部 y > viewport-150 → footer, 窄侧边 → sidebar

12 种区域类型：navigation / search / main-content / sidebar / header / footer / modal / form / list / card / trending / unknown

#### 可见性检测

`isVisible` 函数排除不可操作元素：
- `display: none` / `visibility: hidden` / `opacity: 0`
- 零尺寸且非定位元素
- 向上遍历父链检查隐藏祖先

#### 角色推断

`getRole` 优先级：aria role 属性 > 标签映射。Input 类型映射为特定角色（checkbox/radio/file-upload/date-picker/range-slider/color-picker/searchbox/text-input/button）。

#### 交互类型推断

`inferInteractionHint` 规则：

| 元素特征 | 推断结果 |
|---------|---------|
| submit 类型按钮 | `submit` |
| cancel/close 类名按钮 | `cancel` |
| 外部链接 | `navigation` |
| input/textarea | `input` |
| select/checkbox/radio | `selection` |
| switch/toggle | `toggle` |
| 默认按钮 | `action` |

#### 自动滚动机制

- 以 300px 步进向下滚动，每步间隔 100ms
- 累积滚动直到 `totalHeight >= document.body.scrollHeight`
- 滚动完成后回到顶部并等待 500ms
- 目的：触发懒加载内容，确保所有元素在 DOM 中可见

#### 两种扫描模式

| 模式 | 函数 | 使用场景 | 实现 |
|------|------|---------|------|
| **独立扫描** | `scanPage()` | 首轮执行 | 启动子进程（`scanner-worker.mjs`），独立浏览器实例 |
| **页面内扫描** | `scanPageFromPlaywrightPage()` | 多轮后续执行 | 直接在已有 Playwright Page 上注入脚本，无需新浏览器 |

---

### Layer 3: Vector — 向量过滤

通过本地语义向量模型 + 关键词匹配 + 位置评分的三路混合检索，从扫描结果中精准定位目标元素。

#### 嵌入模型

- **模型**：`Xenova/paraphrase-multilingual-MiniLM-L12-v2`
- **类型**：多语言句子变换器（支持 50+ 语言包括中文）
- **运行方式**：本地推理，通过 `@xenova/transformers` 的 `feature-extraction` pipeline
- **配置**：量化模式（`quantized: true`），模型缓存目录 `./.model-cache`
- **输出**：均值池化（mean pooling）+ L2 归一化的单位向量
- **加载**：单例懒加载，首次调用时下载并缓存模型

#### 元素嵌入文本生成

`generateElementEmbeddingText` 将每个元素拼接为描述文本：

```
[semantics.description] [label] [text(前100字)] [tag] [role]
位于[zone]区域 交互类型:[interactionHint]
[选择器语义标签]
```

选择器语义标签通过正则匹配选择器中的关键词（如 `hot|trending|热搜|热门` → "热搜热门"），弥补纯文本描述的语义缺失。

#### 查询文本生成

`generateStepSearchQuery` 为每个 flow 步骤生成搜索查询：

```
[target] [desc] [elementHint.keywords] [elementHint.interactionHint]
[elementHint.zoneHint] [positionalHint.ordinal → "列表 条目 项目"]
[action类型描述]
```

#### 四阶段漏斗式匹配

**阶段 1 — 硬过滤**（在向量搜索前执行）

| 规则 | 条件 | 效果 |
|------|------|------|
| interactionHint 兼容性 | step 需要特定交互类型时 | 只保留匹配或兼容类型（submit ↔ action, input ↔ selection） |
| Modal 层约束 | zoneHint 包含 modal 时 | 只保留 modal 区域元素 |

**阶段 2 — 三路混合检索** (`hybridSearch`)

```
总分 = 语义向量分(×0.5) + 关键词分(×0.2) + 位置分(×0.3) + 特征精准加分
```

| 通道 | 权重 | 算法 |
|------|------|------|
| **语义向量** | 0.5 | cosineSimilarity(queryVector, elementVector)，minScore=0.3 过滤 |
| **关键词** | 0.2 | 每个匹配关键词 +0.3，interactionHint 匹配 +0.2，上限 1.0 |
| **位置** | 0.3 | ordinal 按 y 坐标排序加分（最高 0.3），direction 按方位归一化加分（最高 0.15） |
| **特征精准** | 附加 | interactionHint 匹配 +0.15，roleHint 匹配 +0.1，zoneHint 匹配 +0.1 |

**位置评分细节**：

- **ordinal 评分**：元素按 y 坐标排序（ordinal>0 升序，ordinal<0 降序），前 N 个元素获得衰减加分 `0.3 × (1 - i/groupSize)`
- **direction 评分**：基于 1920×1080 视口归一化（top: `0.15×(1-y/1080)`, bottom: `0.15×(y/1080)` 等）
- **zone 过滤**：当 scope='zone' 且 zoneHint 指定时，只在对应区域内评分

**阶段 3 — 去重与 topK 截断**

同一元素可被不同 step 匹配（以 `element.uid:stepIndex` 去重），全局按分数降序取 topK（默认 20）。

**阶段 4 — 区域分组**

将 topK 元素按 zone 分组为 `groupedElements`，供 Abstractor 层使用。

---

### Layer 4: Abstractor — 伪代码生成

将意图计划与元素匹配结果组合为可执行的伪代码序列，支持 LLM 生成和模板兜底两种模式。

#### LLM 生成流程

```
FlowStep[] + VectorResult → LLM Prompt → <thinking>推理 → 伪代码行
                                                            ↓ 校验
                                            extract 步骤缺失？→ 补充
                                            非navigate步骤不足？→ fallback 合并
```

1. 构造 System Prompt（匹配策略 P1-P6 + 跨页面隔离 + 操作映射规则）
2. 构造 User Prompt（flow 步骤 + 页面快照 + Top3 匹配结果 + 多轮提示）
3. 流式调用 LLM，提取推理过程
4. 解析伪代码行（匹配 `/^[a-zA-Z][a-zA-Z0-9]*\(/` 模式）
5. 校验并补充缺失步骤

#### 六级元素匹配策略（P1-P6，严格优先级）

LLM 必须按优先级从高到低匹配，命中即停：

| 优先级 | 策略 | 条件 |
|--------|------|------|
| **P1** | 阈值采纳 | Top1 匹配 score ≥ 0.7，直接采纳 |
| **P2** | elementHint 精准匹配 | interactionHint + keywords + roleHint 三项满足两项 |
| **P3** | 语义描述匹配 | semantics.description 含目标关键词 + interactionHint 匹配 |
| **P4** | 标签匹配 | element.label 与 flow.target 完全相同或高度相似 |
| **P5** | 位置辅助匹配 | 结合 positionalHint.ordinal + rect.y 坐标排序 |
| **P6** | 类型兜底匹配 | 按 action 类型映射交互类型（fill→input, click→submit/navigation） |

#### 匹配失败处理

**禁止静默跳过**：找不到匹配元素时必须输出 WARNING 注释：

```
# WARNING: 未找到匹配元素 — flow.target="搜索输入框"
# 候选元素：#kw (input), #form .search (form)
wait(2000)
```

Runner 层会据此触发重试机制。不输出 WARNING 会导致静默失败。

#### 跨页面隔离机制

- 当 flow 第一步是 navigate 且当前快照 URL ≠ 目标 URL：**只输出 navigate**，禁止使用旧页面 selector
- 多轮执行：只基于当前页面快照生成伪代码，不假设旧页面元素仍存在

#### sourceStep 映射算法

`buildPseudoCodeLines` 通过**顺序贪婪匹配**将伪代码行映射回 FlowStep，用于 Pipeline 的步骤完成追踪：

1. 为每个伪代码行提取方法名，映射到 action 类型（如 `getText` → `extract`，`click` → `click`）
2. 从 `nextFlowIdx=0` 开始，向前扫描 `intention.flow` 找到第一个 action 类型匹配的 step
3. 记录映射 `pseudocodeIndex → flowStepIndex`，推进 `nextFlowIdx`
4. 不匹配的行（如 WARNING 生成的 wait）得到 `sourceStep = -1`

#### 模板兜底 (`fallbackAbstract`)

当 LLM 调用失败时，按模板生成伪代码：

| flow action | 伪代码模板 |
|-------------|-----------|
| navigate | `open('target')` |
| click + match | `click('selector')` |
| fill + match | `fill('selector', 'value')` |
| extract + match | `getText('selector')` |
| scroll | `scrollDown()` |
| wait | `wait(2000)` |
| 无匹配 | `# WARNING: 未找到匹配元素` + `wait(2000)` |

#### extract 步骤补充逻辑

当 LLM 漏掉 extract 步骤时，代码自动补充：
1. 在 vector matches 中查找对应 stepIndex 的匹配
2. 使用匹配元素的 selector 生成 `getText('selector')`
3. 若 vector match 分数过低（< 0.5）或无 match，尝试更智能的 fallback：
   - 根据 positionalHint.ordinal 在对应 zone 的元素中按 y 坐标排序选取
   - 在 trending/main-content/list zone 中选取首个元素
4. 最终兜底使用 `body` 选择器

---

### Layer 5: Runner — 执行引擎

逐行解析伪代码，调用 Playwright 执行浏览器操作，支持自愈重试、覆盖层处理和页面跳转检测。

#### 伪代码解析 (`parsePseudo`)

每行伪代码解析为 `{ method, args, isComment }`：

```
fill('#kw', 'iPhone 15')  → { method: 'fill',  args: ['#kw', 'iPhone 15'], isComment: false }
# WARNING: ...            → { method: 'comment', args: ['# WARNING: ...'],  isComment: true }
wait(2000)                → { method: 'wait',   args: ['2000'],             isComment: false }
```

参数提取：优先匹配引号参数（`'value'` / `"value"`），无引号时按逗号分割提取裸值。

#### 操作映射与执行

| 伪代码方法 | Playwright 实现 | 说明 |
|------------|-----------------|------|
| `navigate` / `open` | `page.goto(url)` | waitUntil: domcontentloaded |
| `click` / `doubleClick` | `clickWithOverlayFallback` | 三级覆盖层处理 |
| `fill` | `fillWithVisibilityFallback` | 三级可见性处理 |
| `select` | `page.selectOption` | scrollIntoView + JS 降级 |
| `check` / `uncheck` | `page.check` / `page.uncheck` | — |
| `scrollDown` / `scrollUp` | `page.mouse.wheel(0, ±800)` | — |
| `screenshot` | `page.screenshot({ fullPage: true })` | 返回 base64 |
| `getText` / `extract` | `page.textContent(selector)` | 带自愈提取 |
| `wait` | `smartWait` / `waitForSelector` | 数字=智能等待，选择器=等待可见 |
| `waitForElementVisible` | `page.waitForSelector` | state: visible, timeout: 10s |
| `scrollToElement` | `locator.scrollIntoViewIfNeeded` | — |
| `extractWithRegex` | `textContent` + `RegExp` 匹配 | — |

#### 三级 Click 覆盖层处理

```
page.click(selector)
  ↓ 失败: "intercepts pointer events"
dismissOverlays(): 计算中心点 → elementFromPoint → 检测覆盖层 → 关闭按钮/pointer-events:none
  ↓ 重试
page.click(selector)
  ↓ 仍然失败
page.evaluate(() => document.querySelector(sel)?.click())  // JS 直接点击
```

`dismissOverlays` 在浏览器端运行：
1. 计算目标元素中心点坐标
2. `elementFromPoint` 检测遮挡元素
3. 查找覆盖层容器（modal/overlay/dialog/popup class 匹配）
4. 尝试点击关闭按钮或设置 `pointer-events: none`

#### 三级 Fill 可见性处理

```
page.fill(selector, value)
  ↓ 失败: "not visible" / "not editable"
scrollIntoViewIfNeeded → page.fill(selector, value)
  ↓ 仍然失败
JS 原生 setter: nativeInputValueSetter.call(el, val) + dispatch input/change 事件
```

JS 降级模式会移除 readonly/disabled 属性，使用 `HTMLInputElement.prototype.value` 的原生 setter 确保值被正确设置，并触发 input + change 事件以激活页面表单逻辑。

#### 自愈重试机制

当步骤失败且错误为 "not attached" / "detached" / "not found" 时，触发 `rescanForElement` 在浏览器端查找替代选择器：

1. **直接检查**：`document.querySelector(oldSelector)` — 如仍连接则返回原始选择器
2. **ID 查找**：提取 `#id` 通过 `getElementById` 检查
3. **标签+文本匹配**：提取 tag 和 `has-text("...")` 扫描同标签元素的 textContent
4. **name 属性匹配**：提取 `[name="..."]` 通过 name 属性查询

找到替代选择器后替换并重试，最多重试 `MAX_SELF_HEAL_RETRIES = 2` 次。

#### 页面跳转检测

在执行 `navigate`/`open`/`click`/`doubleClick` 后（当 `stopOnNavigation` 启用时）：

1. 等待 `domcontentloaded`（最多 3 秒）
2. **新 Tab 检测**：`context.pages()` 数量增加 → 找到最后一个 page，检查 URL 是否变化
3. **URL 变化检测**：`page.url() !== urlBeforeAction`
4. 检测到跳转时：记录 `navigationDetected = true` + `navigatedToUrl`，当前步骤标记为成功，**立即中断执行循环**
5. 如打开新 Tab：切换 `page = newPage`，调用 `updateSessionPage` 更新浏览器会话

跳转后的剩余步骤由 Pipeline 下一轮重新扫描执行。

---

### Pipeline — 多轮流水线编排

Pipeline 编排五层流水线的多轮执行，支持页面跳转后的自动续行。

#### 多轮执行循环

```
Intention（仅一次）
  │
  ▼
┌──────────────────────────────────────────────┐
│ for roundIndex = 0; roundIndex < maxRounds:  │
│                                              │
│   ┌─ 检查完成 ── 所有 step 已完成？→ 退出    │
│   │                                          │
│   ├─ 分析当前轮步骤（analyzeFlowStepsForRound）│
│   │                                          │
│   ├─ Scanner（首轮: scanPage / 后续: scanPageFromPlaywrightPage）│
│   ├─ Vector                                  │
│   ├─ Abstractor                              │
│   ├─ Runner（stopOnNavigation=true）          │
│   │                                          │
│   ├─ 步骤完成追踪（sourceStep 精确映射）      │
│   │                                          │
│   ├─ 导航检测？→ 成功+导航 → 继续下一轮      │
│   │            → 无导航 → 退出                │
│   │            → 失败 → 退出                  │
│   └──────────────────────────────────────────┘
```

#### 步骤分区 (`analyzeFlowStepsForRound`)

从第一个未完成的 step 开始，按顺序收集当前轮应执行的步骤：

- 跳过已完成的步骤（`completedStepIndices`）
- **navigate 步骤截断**：若 navigate 不是当前轮第一个步骤，在此处截断（navigate 留给下一轮作为起始步骤）
- **click 标记**：click 可能导致页面跳转，标记但不截断（由 Runner 运行时检测实际跳转）

#### 步骤完成追踪

**精确映射**：使用 `abstractor.pseudoCode[i].sourceStep` 将已执行的伪代码行映射回 `roundIntention.flow` 的步骤索引，再通过 `currentRoundSteps` 映射回原始 `intention.flow` 的索引。

| 场景 | 处理 |
|------|------|
| 无导航 + 全部成功 | 当前轮所有 `currentRoundSteps` 标记为完成 |
| 导航或部分失败 | 遍历 `runner.steps`，只标记 `sourceStep >= 0` 的步骤为完成 |
| sourceStep 映射无结果 | 退回到位置计数法（前 N 个 currentRoundSteps） |

#### 浏览器会话共享

通过 `browser-registry` 的 `BrowserSession` 在多轮间复用浏览器上下文：

```typescript
interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  reused: boolean;
}
```

| 函数 | 说明 |
|------|------|
| `getOrCreateSession()` | 获取或创建会话（支持 context/page 复用） |
| `updateSessionPage()` | 更新会话的当前 Page（跳转新 Tab 后调用） |
| `getSessionPage()` | 获取当前 Page（下一轮扫描时使用） |

首轮由 Runner 创建浏览器实例，后续轮通过 `existingPage` + `existingContext` 参数传入已有会话，避免重复启动浏览器。

#### 完整多轮示例

以"百度搜索 iPhone 16 Pro → 点击第一条结果 → 获取详情"为例：

```
Round 0: flow = [navigate, fill, click, extract]
  Scanner  → 扫描百度首页（scanPage）
  Vector   → 匹配搜索框、搜索按钮
  Abstractor → navigate(url), fill('#kw', ...), click('#su'), getText(...)
  Runner   → 执行 navigate + fill + click → 检测到页面跳转
  完成追踪 → steps 0,1,2 完成，step 3 未完成

Round 1: flow = [extract]（step 3）
  Scanner  → 扫描新页面（scanPageFromPlaywrightPage）
  Vector   → 匹配结果页元素
  Abstractor → getText('#result')
  Runner   → 执行 getText → 无导航，成功
  完成追踪 → step 3 完成 → 全部完成，退出
```

---

## SSE 事件流

Pipeline 通过 SSE（Server-Sent Events）实时推送执行进度：

### 单轮事件流

```
task.start
  → intention.start → intention.thinking × N → intention.done
  → pipeline.round-start { roundIndex: 0 }
  → scanner.start → scanner.scanning → scanner.done
  → vector.start → vector.filtering → vector.computing → vector.done
  → abstractor.start → abstractor.done
  → runner.start → runner.step-start → runner.step-done → runner.done
  → task.done
```

### 多轮事件流

```
... (Round 0 同上)
  → runner.done { navigationDetected: true, navigatedToUrl: "..." }
  → pipeline.round-start { roundIndex: 1 }
  → scanner.start → scanner.done  (扫描新页面)
  → vector.start → vector.done
  → abstractor.start → abstractor.done
  → runner.start → runner.step-start → runner.step-done → runner.done
  → task.done
```

### 事件类型一览

| 事件 | 数据 |
|------|------|
| `task.start` | `{ question }` |
| `intention.start` | `{ question }` |
| `intention.thinking` | `{ delta, accumulated }` |
| `intention.done` | `{ status, reply, flow, question }` |
| `pipeline.round-start` | `{ roundIndex, totalRounds, completedSteps, totalSteps }` |
| `scanner.start` | `{ url, waitForStable }` |
| `scanner.scanning` | `{ phase, message }` |
| `scanner.done` | `{ url, title, totalElements }` |
| `vector.start` | `{ totalElements }` |
| `vector.filtering` | `{ stepIndex, before, after }` |
| `vector.computing` | `{ stepIndex }` |
| `vector.done` | `{ afterHardFilter }` |
| `abstractor.start` | `{ totalSteps }` |
| `abstractor.done` | `{ pseudoCode, generationMethod, warnings }` |
| `runner.start` | `{ totalSteps, headless, roundIndex }` |
| `runner.step-start` | `{ lineNumber, code, action }` |
| `runner.step-done` | `{ lineNumber, code, status, elapsedMs }` |
| `runner.step-error` | `{ lineNumber, error, retrying }` |
| `runner.extract` | `{ lineNumber, selector, text }` |
| `runner.done` | `{ success, steps, extractedContent, navigationDetected, navigatedToUrl }` |
| `task.done` | `{ success, sessionId, totalRounds }` |
| `task.error` | `{ step, message }` |

---

## 快速上手

### 环境要求

- [Bun](https://bun.sh/) >= 1.0
- [Node.js](https://nodejs.org/) >= 18 (Playwright 运行时需要)
- Chromium 浏览器 (首次运行自动安装)

### 1. 克隆项目

```bash
git clone https://github.com/heyy0415/browser-hand.git
cd browser-hand
```

### 2. 安装依赖

```bash
bun install
```

### 3. 安装 Playwright 浏览器

```bash
npx playwright install chromium
```

### 4. 配置 LLM API Key

编辑 `packages/core/constants.ts`，填入你的 DashScope API Key：

```typescript
export const LLM_CONFIG = {
  apiKey: "your-api-key-here",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: "qwen-flash",
};
```

> 默认使用阿里云通义千问 (DashScope)，兼容 OpenAI API 格式。如需切换其他模型，修改 `baseUrl` 和 `model` 即可。

### 5. 启动开发服务

```bash
bun run dev
```

这将同时启动：
- 后端服务: `http://localhost:3000`
- 前端界面: `http://localhost:5173`

### 6. 开始使用

打开前端界面，在输入框中输入自然语言指令，例如：

- `打开百度`
- `在京东搜索手机壳`
- `帮我打开百度，获取热搜的第一条`

系统将通过 SSE 实时展示每层的执行进度，包括意图推理过程、页面扫描结果、元素匹配分数和执行状态。

---

## API 接口

### POST /api/task

发起一个浏览器自动化任务，通过 SSE 流式返回执行进度。

**请求体:**

```json
{
  "question": "帮我打开百度，获取热搜的第一条",
  "headless": false,
  "sessionId": "可选，会话 ID",
  "model": "可选，模型名称",
  "context": "可选，对话上下文"
}
```

### GET /api/health

健康检查，返回 `{ "status": "ok" }`。

---

## 开发

```bash
# 仅启动后端
bun run dev:server

# 仅启动前端
bun run dev:web

# 类型检查
bun run typecheck

# 代码检查
bun run lint

# 运行测试
bun test
```

---

## License

MIT
