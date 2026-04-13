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

### 为什么是五层？

| 层 | 解决什么问题 | 关键设计 |
|---|---|---|
| **Intention** | 自然语言歧义 → 结构化指令 | LLM 流式推理，支持澄清与拒绝 |
| **Scanner** | 页面元素不可知 → 六维结构化快照 | Playwright 注入脚本，提取身份/语义/空间/顺序/状态/区域 |
| **Vector** | 语义无法区分"第几条" → 引入位置维度 | 本地 Transformer 向量检索 + 关键词匹配 + 位置排序，四阶段漏斗 |
| **Abstractor** | 选择器与操作的对齐 → 可执行伪代码 | 高置信度用模板（零 LLM 调用），低置信度调 LLM 决策 |
| **Runner** | 伪代码 → 浏览器真实操作 | Playwright 执行 + 失败自动重试 + 内容提取 |

---

## 架构概览

```
browser-hand/
├── packages/core/          # @browser-hand/core — 核心五层引擎
│   ├── pipeline.ts         #   流水线编排
│   ├── llm.ts              #   LLM 客户端 + SSE 流
│   ├── constants.ts        #   Prompt 模板 + 配置
│   ├── types.ts            #   全局类型定义
│   ├── browser-registry.ts #   浏览器实例池
│   └── layers/
│       ├── intention.ts    #   Layer 1: 意图解析
│       ├── scanner.ts      #   Layer 2: 页面扫描
│       ├── vector.ts       #   Layer 3: 向量过滤
│       ├── abstractor.ts   #   Layer 4: 伪代码生成
│       └── runner.ts       #   Layer 5: 执行引擎
├── apps/server/            # @browser-hand/server — Hono HTTP 服务
│   └── src/index.ts        #   POST /api/task (SSE)
└── apps/web/               # @browser-hand/web — React 前端
    └── src/
        ├── components/     #   聊天界面、管线进度条、时间线
        ├── hooks/          #   SSE 事件处理
        └── services/       #   API 调用
```

**技术栈**: Bun · TypeScript · React 19 · Hono · Playwright · OpenAI API (Qwen) · @xenova/transformers (本地向量模型)

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

**SSE 事件流:**

```
task.start → intention.start → intention.thinking × N → intention.done
           → scanner.start → scanner.scanning → scanner.done
           → vector.start → vector.filtering → vector.computing → vector.done
           → abstractor.start → abstractor.done
           → runner.start → runner.step-start → runner.step-done → runner.done
           → task.done
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
