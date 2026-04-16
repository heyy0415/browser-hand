# Browser Hand

**一句话操控浏览器 — 让网页听懂人话**

Browser Hand 是一个自然语言驱动的浏览器自动化引擎。用户只需输入自然语言指令（如"帮我打开百度，获取热搜第一条"），系统即可自动完成意图解析、页面扫描、智能过滤、伪代码生成与执行，全程通过 SSE 实时反馈进度。

---

## 核心思想

传统浏览器自动化依赖硬编码选择器，脆弱且不可扩展。Browser Hand 的核心理念是：**让浏览器理解语义，而非让开发者编写选择器**。

为此，我们设计了事件驱动的递进式流水线，将自然语言逐步转化为可执行的浏览器操作，并通过重入状态机自动处理页面跳转和动态变更：

```
用户输入: "帮我打开百度，获取热搜的第一条"
    │
    ▼
┌───────────┐
│ Intention  │  意图解析 — 将自然语言解析为结构化操作计划（仅执行一次）
└─────┬─────┘
      │ FlowStep[]
      ▼
┌───────────────────────────────────────────────────────┐
│                                                       │
│  Runner 状态机（事件驱动重入循环，最多 5 轮）             │
│                                                       │
│  ┌──────────┐   ┌──────────────┐   ┌────────────┐    │
│  │ Scanner   │ → │ Vector Gateway│ → │ Abstractor │    │
│  │ 双轨扫描  │   │ 智能过滤网关  │   │ 伪代码生成  │    │
│  └──────────┘   └──────────────┘   └─────┬──────┘    │
│       │                │                   │           │
│   domText          filteredDomText    click([3])      │
│   elementMap       elementMap         fill([2],'val') │
│                                          │            │
│                                          ▼            │
│                                    ┌──────────┐      │
│                                    │ 逐步执行  │      │
│                                    └─────┬────┘      │
│                                          │            │
│                          ┌─── 突变检测 ───┤            │
│                          │               │            │
│                     页面跳转/弹窗      无变化          │
│                     → 继续循环        → 任务完成       │
│                                                       │
└───────────────────────────────────────────────────────┘
```

每一层各司其职：Scanner 产出双轨数据，Vector Gateway 智能裁剪上下文，Abstractor 生成索引化伪代码，Runner 执行并监测页面突变。层间通过内部函数调用传递完整数据，同时通过 SSE 向前端推送轻量级事件摘要，实现实时可视化。

---

## 架构概览

```
browser-hand/
├── packages/core/          # @browser-hand/core — 核心引擎
│   ├── pipeline.ts         #   流水线编排（Intention → navigate → Runner 状态机）
│   ├── llm.ts              #   LLM 客户端 + SSE 流
│   ├── constants.ts        #   Prompt 模板 + 配置
│   ├── types.ts            #   全局类型定义
│   ├── browser-registry.ts #   浏览器会话池
│   └── layers/
│       ├── intention.ts                  # Layer 1: 意图解析
│       ├── scanner.ts                    # Layer 2: 页面扫描（双轨输出）
│       ├── scanner-extraction-script.ts  #         浏览器端元素提取脚本
│       ├── scanner-worker.mjs            #         Scanner 子进程 Worker
│       ├── vector.ts                     # Layer 3: 智能过滤网关
│       ├── abstractor.ts                 # Layer 4: 伪代码生成
│       └── runner.ts                     # Layer 5: 事件驱动执行引擎
├── apps/server/            # @browser-hand/server — Hono HTTP 服务
│   └── src/index.ts        #   POST /api/task (SSE)
└── apps/web/               # @browser-hand/web — React 前端
    └── src/
        ├── components/     #   聊天界面、网关路由、重入提示、执行时间线
        ├── hooks/          #   SSE 事件处理（多轮累积）
        └── services/       #   API 调用
```

**技术栈**: Bun · TypeScript · React 19 · Hono · Playwright · OpenAI API (Qwen) · @xenova/transformers (本地向量模型)

---

## 架构技术详解

### Layer 1: Intention — 意图解析

将用户的自然语言输入转化为结构化的操作计划（`FlowStep[]`），仅在流水线启动时执行一次。

#### 解析流程

```
用户输入 → LLM 流式推理 → <thinking>校验清单 → JSON 输出 → Zod 校验 → IntentionResult
                                     ↓ 失败
                              重试（最多 2 次）→ 正则兜底 → out_of_scope
```

1. **LLM 主路径**：构造 System Prompt + User Prompt 消息序列，流式调用 LLM，提取 `<thinking>...</thinking>` 内的推理过程展示给用户，解析 `</thinking>` 后的 JSON 输出
2. **Zod 严格校验**：使用 `IntentionResultSchema` 对 LLM 输出进行严格校验，校验失败时将错误信息追加到对话上下文进行重试
3. **正则兜底**：LLM 连续 2 次失败后，使用 `regexFallback` 匹配 "打开/进入/访问 + 站名" 模式

#### 三种输出状态

| 状态 | 含义 | 示例 |
|------|------|------|
| `success` | 成功解析，返回 `flow: FlowStep[]` | "打开百度搜索手机" → navigate + fill + click |
| `clarification_needed` | 歧义需要澄清，返回 `question: string[]` | "搜索手机" → 需要确认平台 |
| `out_of_scope` | 非浏览器操作，返回 `reply: string` | "今天天气怎么样" → 拒绝执行 |

#### FlowStep 结构

每个操作步骤包含 `action`（10 种标准操作类型）、`target`（目标描述）、`elementHint`（元素特征提示，含 interactionHint/zoneHint/roleHint/keywords）和 `positionalHint`（位置概念提示，含 ordinal/direction/scope）。

**ElementHint** 为后续 Vector Gateway 提供结构化约束，是 Plan A 硬过滤的核心输入。

---

### Layer 2: Scanner — 双轨页面扫描

通过 Playwright 注入脚本，采集页面元素信息，产出双轨分离数据：**domText**（给 LLM 看的极简纯文本）和 **elementMap**（给算法用的结构化映射表）。

#### 双轨输出

| 轨道 | 数据 | 消费者 | 特点 |
|------|------|--------|------|
| **domText** | 带空间属性的极简纯文本 | Abstractor (LLM) | 每行 `[index]` 前缀，含 `data-zone`、`data-pos`、`data-shadow` 属性 |
| **elementMap** | 结构化坐标元数据 | Vector Gateway / Runner | selector / rect / zone / role / rawText / embeddingText / shadowHosts |

domText 示例：

```
[0] <header data-zone="header" data-pos="top-center">
[1] <input placeholder="搜索" data-zone="search" data-pos="top-center">
[2] <button data-zone="search" data-pos="top-center">搜索</button>
```

elementMap 与 domText 的 `[index]` 一一对应，Runner 执行时通过索引查找真实 CSS selector。

#### 功能区域检测

三级检测策略：语义化父标签（`<nav>`, `<main>`, `<form>` 等）→ class/ID 模式匹配 → 位置启发式。支持 12 种区域类型。

#### Shadow DOM / 微前端穿透

Scanner 递归穿透 Shadow DOM 和 iframe，提取的元素在 elementMap 中记录 `shadowHosts` 宿主链，selector 使用 `>>>` 穿透语法（如 `my-dialog >>> x-form >>> button`），Runner 执行时自动转换为 Playwright 兼容的 `>>` 格式。

#### 两种扫描模式

| 模式 | 函数 | 使用场景 |
|------|------|---------|
| **独立扫描** | `scanPage()` | 首轮执行（启动子进程 Worker） |
| **页面内扫描** | `scanPageFromPlaywrightPage()` | 重入后续轮（直接在已有 Page 上注入脚本） |

---

### Layer 3: Vector Gateway — 智能过滤网关

根据 FlowStep 的结构化特征，智能选择过滤路径，将数百行 domText 裁剪至寥寥数行，极大降低 LLM 推理成本。

#### 双路径路由

| 路径 | 条件 | 延迟 | 适用场景 |
|------|------|------|---------|
| **Plan A: 硬过滤** | elementHint / positionalHint 非空 | 0ms | 99% 的正常指令 |
| **Plan B: 语义降级** | 指令极度模糊（hint 全为空） | ~200ms | 1% 的模糊指令 |

**自动降级**：Plan A 结果为空时自动降级到 Plan B，保证不遗漏。

#### Plan A: 六维硬过滤

按顺序对 elementMap 执行级联裁剪：

1. **空间拦截**（direction）— 按视口归一化坐标过滤（如 `bottom` → `yRatio > 0.6`）
2. **序号拦截**（ordinal）— 按 y 坐标排序取前 N 个（"第一条" → `slice(0, 1)`）
3. **区域拦截**（zoneHint）— 只保留目标区域元素
4. **角色拦截**（roleHint / interactionHint）— 只保留匹配角色（含兼容映射：submit↔button, input↔searchbox 等）
5. **关键词兜底**（rawText includes）— 在候选集中按关键词进一步过滤
6. **上下文扩展** — 命中索引 ±1 邻居，保留 LLM 理解所需的上下文

#### Plan B: 向量语义检索

使用 `@xenova/transformers` 加载 `Xenova/paraphrase-multilingual-MiniLM-L12-v2` 本地推理，对 elementMap.embeddingText 生成向量，对每个 FlowStep 的查询文本做 Top-K 召回（K=5, minScore=0.3），同样扩展 ±1 邻居。

#### 压缩效果

典型场景下，350 行 domText 可被压缩至 7 行，压缩比 98%，极大减少 LLM token 消耗。

---

### Layer 4: Abstractor — 索引化伪代码生成

将过滤后的精简 domText 与 FlowStep 组合，生成基于 elementMap 索引的伪代码，支持 LLM 生成和模板兜底两种模式。

#### 索引格式

伪代码使用 `[index]` 引用 elementMap 中的元素，而非直接使用 CSS selector：

```
click([3])              → Runner 查找 elementMap[3].selector → 执行
fill([2], 'iPhone 16')  → Runner 查找 elementMap[2].selector → 填入值
getText([5])            → Runner 查找 elementMap[5].selector → 提取文本
```

这种方式使 LLM 无需理解复杂的 CSS 选择器，只需从 domText 中选择对应的 `[index]` 编号。

#### LLM 生成流程

```
FlowStep[] + filteredDomText → LLM Prompt → <thinking>推理 → 索引化伪代码
                                                               ↓ 校验
                                                extract 步骤缺失？→ 补充
                                                步骤不足？→ fallback 合并
```

输入仅为 flow 和 filteredDomText（v2.0 精简为 2 部分），LLM 从 domText 行中识别匹配元素的 `[index]` 编号。

#### 五级元素匹配策略（P1-P5）

LLM 按优先级从高到低匹配元素：

| 优先级 | 策略 | 条件 |
|--------|------|------|
| **P1** | 精准属性匹配 | data-zone + data-pos + 交互属性三重匹配 |
| **P2** | 语义描述匹配 | semantics.description 含目标关键词 + interactionHint 匹配 |
| **P3** | 标签匹配 | element.label 与 flow.target 完全相同或高度相似 |
| **P4** | 位置辅助匹配 | 结合 ordinal + y 坐标排序 |
| **P5** | 类型兜底匹配 | 按 action 类型映射交互类型 |

#### 模板兜底 (`fallbackAbstract`)

当 LLM 调用失败时，根据 FlowStep 的 elementHint 对 elementMap 做 zone/role/keyword 匹配评分，选择最高分元素生成伪代码。

---

### Layer 5: Runner — 事件驱动重入状态机

逐行解析索引化伪代码，调用 Playwright 执行浏览器操作，并通过 MutationObserver + URL 变化检测实现自动重入。

#### 状态机核心循环

```
while (remainingFlow.length > 0 && round < maxRounds):
  1. Scanner 扫描当前页面 → domText + elementMap
  2. Vector Gateway 过滤 → filteredDomText
  3. Abstractor 生成伪代码 → click([3]) / fill([2], 'val')
  4. 逐步执行伪代码:
     - click 步骤: clickAndWaitForMutation → 突变则 break, 继续 while
     - 其他步骤: 直接执行
  5. 无突变 → break while (完成)
  6. 突变 → 计算 remainingFlow, 继续 while
```

#### 突变检测机制

每个 click 步骤执行前，注入 MutationObserver 监听 body childList 变化，点击后轮询检测：

| 突变类型 | 检测方式 | 后续动作 |
|---------|---------|---------|
| `URL_CHANGE` | `page.url() !== urlBefore` | 记录 stateChange，重入扫描新页面 |
| `DOM_MUTATION` | `window.__mutationDetected` | 记录 stateChange，重入扫描弹窗/动态内容 |
| `NONE` | 超时（5s）无变化 | 继续执行下一步骤 |

#### 索引到选择器的解析

`resolveSelectorFromArgs` 将 `[N]` 参数解析为 `elementMap[N].selector`，再通过 `toPlaywrightSelector` 将 Shadow DOM 的 `>>>` 穿透语法转换为 Playwright 的 `>>` 格式。

#### 三级 Click 覆盖层处理

```
page.click(selector) → 失败: "intercepts pointer events"
  → dismissOverlays(): 计算中心点 → elementFromPoint → 关闭按钮 / pointer-events:none
  → 重试 page.click(selector) → 仍然失败
  → JS 直接点击: document.querySelector(sel)?.click()
```

#### 三级 Fill 可见性处理

```
page.fill(selector, value) → 失败: "not visible"
  → scrollIntoViewIfNeeded + page.fill → 仍然失败
  → JS 原生 setter: nativeInputValueSetter.call(el, val) + 触发 input/change 事件
```

#### 自愈重试机制

当步骤失败且错误为 "not attached" / "detached" 时，在浏览器端查找替代选择器（直接检查 → ID 查找 → 标签+文本匹配 → name 属性匹配），找到后替换重试。

---

### Pipeline — 流水线编排

Pipeline 编排 Intention 解析和 Runner 状态机的启动，v2.0 大幅精简为三步：

```
1. Intention 解析（仅一次）
2. 处理首个 navigate 步骤（page.goto）
3. 启动 Runner 状态机（executeWithStateControl）
```

Scanner / Vector Gateway / Abstractor 均由 Runner 状态机内部调用，Pipeline 不再直接管理多轮循环。SSE 事件通过 RunnerCallbacks 转发。

---

## SSE 事件流

Pipeline 通过 SSE（Server-Sent Events）实时推送执行进度：

### 事件流示例

```
task.start
  → intention.start → intention.thinking × N → intention.done
  → pipeline.round-start { roundIndex: 0 }
  → scanner.start → scanner.done
  → vector.start → vector.gateway { route: 'PLAN_A_HARDFILTER', compressionRatio: '98%' } → vector.done
  → abstractor.start → abstractor.thinking × N → abstractor.done
  → runner.start → runner.step-start → runner.step-done → ...
  → state_change_detected { type: 'URL_CHANGE', reason: '页面跳转' }
  → pipeline.round-start { roundIndex: 1 }
  → scanner.start → scanner.done
  → vector.start → vector.gateway → vector.done
  → abstractor.start → abstractor.done
  → runner.start → runner.step-start → runner.step-done → runner.done
  → task.done
```

### 事件类型一览

| 事件 | 数据 | 说明 |
|------|------|------|
| `task.start` | `{ question }` | 任务开始 |
| `intention.start` | `{ question }` | 意图解析开始 |
| `intention.thinking` | `{ delta, accumulated }` | LLM 推理过程（流式） |
| `intention.done` | `{ status, reply, flow }` | 意图解析完成 |
| `pipeline.round-start` | `{ roundIndex }` | 新一轮重入开始 |
| `scanner.start` | `{}` | 页面扫描开始 |
| `scanner.done` | `{}` | 页面扫描完成 |
| `vector.start` | `{}` | 网关过滤开始 |
| `vector.gateway` | `{ route, originalLines, filteredLines, compressionRatio }` | 网关路由决策 |
| `vector.done` | `{}` | 网关过滤完成 |
| `abstractor.start` | `{}` | 伪代码生成开始 |
| `abstractor.thinking` | `{ delta }` | Abstractor LLM 推理（流式） |
| `abstractor.done` | `{}` | 伪代码生成完成 |
| `runner.start` | `{}` | 执行引擎启动 |
| `runner.step-start` | `{ lineNumber, code, action }` | 步骤开始 |
| `runner.step-done` | `{ lineNumber, code, status, elapsedMs }` | 步骤完成 |
| `runner.step-error` | `{ lineNumber, error, retrying }` | 步骤错误 |
| `runner.extract` | `{ lineNumber, selector, text }` | 内容提取 |
| `runner.done` | `{ success, steps }` | 执行引擎完成 |
| `state_change_detected` | `{ type, reason, targetUrl }` | 页面突变检测（触发重入） |
| `task.done` | `{ success, sessionId, totalRounds }` | 任务完成 |

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

系统将通过 SSE 实时展示每层的执行进度，包括意图推理过程、网关路由决策、页面突变检测和执行状态。

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
