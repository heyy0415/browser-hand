# browser-hand

> 用自然语言操控浏览器 —— 告诉它你要做什么，它自己搞定。

browser-hand 是一个基于五层流水线的浏览器自动化引擎，将自然语言意图逐步转化为 Playwright 可执行动作，全程通过 SSE 流式输出执行过程。

---

## 技术架构

### 整体结构

```
browser-hand/
├── packages/engine/   # 核心引擎（五层流水线 + 共享模块）
├── apps/server/       # Hono 后端，暴露 SSE 流式接口
└── apps/web/          # React 前端，对话式交互界面
```

Monorepo 管理，使用 Bun workspace，包间通过 `@browser-hand/engine` 引用共享类型与引擎能力。

### 五层流水线

```
用户自然语言
    │
    ▼
┌──────────────┐
│  intention   │  LLM 解析意图 → 结构化步骤流 (action / target / desc)
├──────────────┤
│   scanner    │  Playwright 子进程扫描页面 → 元素快照 + 可见文本
├──────────────┤
│   vector     │  向量化匹配（当前透传，预留相似度检索）
├──────────────┤
│  abstractor  │  LLM 将意图 + 快照映射为伪代码 (click / fill / navigate …)
├──────────────┤
│   runner     │  解析伪代码 → 调用 Playwright API 执行，逐步返回结果
└──────────────┘
    │
    ▼
  执行结果（SSE 实时推送）
```

每一层通过 `Pipeline` 串联，各层产出通过 SSE 事件实时推送到前端，实现"思考过程可见"。

### 数据流

```
前端 ←SSE← Server ←Pipeline← Runner ← Abstractor ← Vector ← Scanner ← Intention ← 用户输入
```

### 关键技术选型

| 层面     | 技术                           |
| -------- | ------------------------------ |
| 运行时   | Bun                            |
| LLM      | 通义千问 (DashScope API)       |
| 浏览器   | Playwright (Chromium)          |
| 后端     | Hono + SSE                     |
| 前端     | React 19 + Vite                |
| 类型系统 | TypeScript（strict mode）      |

---

## 快速上手

### 环境要求

- [Bun](https://bun.sh/) >= 1.0
- Node.js（用于安装 Playwright 浏览器）

### 1. 安装依赖

```bash
bun install
```

### 2. 安装 Playwright 浏览器

```bash
npx playwright install chromium
```

### 3. 启动开发服务

```bash
bun run dev
```

启动后：

- **Web 前端**：http://localhost:5173
- **API 服务**：http://localhost:3000

### 4. 通过 API 调用

```bash
curl -N -X POST "http://localhost:3000/api/task" \
  -H "Content-Type: application/json" \
  -d '{"question": "打开 https://example.com", "headless": true}'
```

### 其他命令

```bash
bun run typecheck   # 类型检查
bun run lint        # 代码检查
bun run test        # 运行测试
bun run build       # 构建前端
```
