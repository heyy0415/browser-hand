# browser-hand 技术设计

---

## 一、项目概述

browser-hand 是一个浏览器自动化引擎，用户通过自然语言输入操控网站。系统通过五层流水线架构（intention → scanner → vector → abstractor → runner）将自然语言转化为可执行的浏览器操作，针对 Token 消耗、准确率、速度三个维度做了全面提升。

---

## 二、技术选型

| 类别 | 选型 | 说明 |
|---|---|---|
| 前端 | React 19 + Vite | 现代化前端框架 |
| 运行时 | Bun（主）+ Node.js（Playwright 层） | Bun 兼容 Playwright 有 Windows 问题，Playwright 执行层用 Node.js |
| 语言 | TypeScript | 全项目统一 |
| 样式 | Tailwind CSS | Web 页面端和插件 UI |
| 代码规范 | ESLint + Husky | Git commit 拦截检测 |
| AI 调用 | LangChain | Intention / Abstractor 层调用 LLM |
| 浏览器控制 | Playwright | Web 页面端无头浏览器执行 |
| 通信协议 | SSE | 五层架构流式输出 |
| 包管理 | Bun | bun install / bun run |
| 后端框架 | Hono | 轻量级 HTTP 服务框架 |

---

## 三、项目结构

```
browser-hand/
├── packages/                       # 共享包
│   ├── engine/                     # 核心引擎（五层架构）
│   │   ├── src/
│   │   │   ├── layers/             # 五层实现
│   │   │   │   ├── intention.ts    # 意图解析层
│   │   │   │   ├── scanner.ts      # 页面扫描层
│   │   │   │   ├── vector.ts       # 向量分析层
│   │   │   │   ├── abstractor.ts   # 操作规划层
│   │   │   │   ├── runner.ts       # 执行器层
│   │   │   │   └── index.ts        # 层导出
│   │   │   ├── types.ts            # 全部类型定义
│   │   │   ├── pipeline.ts         # SSE 流水线编排
│   │   │   ├── utils.ts            # SSE、Logger、LLM 工具
│   │   │   └── index.ts            # 统一导出
│   │   ├── shared/                 # 共享常量和 Prompts
│   │   │   ├── index.ts            # 常量和 Prompts 导出
│   │   │   └── package.json
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── ui/                         # UI 组件库
│       ├── src/
│       │   ├── components/
│       │   │   ├── Chat.tsx        # 聊天组件
│       │   │   └── index.ts
│       │   ├── styles/
│       │   │   └── index.css       # 全局样式
│       │   └── index.ts
│       ├── package.json
│       └── tsconfig.json
│
├── apps/                           # 应用
│   ├── server/                     # 后端服务（Hono + SSE）
│   │   ├── src/
│   │   │   ├── index.ts            # HTTP 服务入口
│   │   │   └── env.d.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── web/                        # Web 前端（React + Vite）
│   │   ├── src/
│   │   │   ├── services/
│   │   │   │   └── taskApi.ts      # API 调用服务
│   │   │   ├── hooks/
│   │   │   │   └── useTask.ts      # 流式数据管理 hook
│   │   │   ├── pages/              # 页面组件（预留）
│   │   │   ├── App.tsx             # 应用入口
│   │   │   ├── main.tsx            # React 挂载点
│   │   │   └── env.d.ts
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── extension/                  # 浏览器插件
│       ├── src/
│       │   ├── services/
│       │   │   └── taskApi.ts      # API 调用服务
│       │   ├── hooks/
│       │   │   └── useTask.ts      # 流式数据管理 hook
│       │   ├── popup.tsx           # 插件弹窗
│       │   ├── background.ts       # 后台脚本
│       │   └── env.d.ts
│       ├── public/
│       │   └── manifest.json       # 插件清单
│       ├── vite.config.ts
│       ├── package.json
│       └── tsconfig.json
│
├── .cursor/                        # Cursor IDE 配置
│   └── rules/                      # 代码规范
├── eslint.config.js
├── tsconfig.json                   # 根 TypeScript 配置
├── package.json                    # 根 package.json（monorepo 配置）
├── bunfig.toml                     # Bun 配置
├── tailwind.config.ts              # Tailwind 配置
├── postcss.config.js               # PostCSS 配置
└── README.md
```

---

## 四、五层架构详细设计

### 4.1 数据流总览

```
用户自然语言输入
       │
       ▼
┌──────────────┐
│  Intention   │  LangChain 调用 LLM，内置提示词解析意图
│  意图解析层    │  输出：操作流程（Flow JSON）
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   Scanner    │  区分端类型，获取页面 DOM 并结构化处理
│  页面扫描层    │  输出：页面元素快照（结构化 JSON）
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   Vector     │  预留层，默认流转，固定返回执行成功
│  向量分析层    │  输出：VectorResult（pass-through）
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Abstractor   │  LangChain 调用 LLM，分析 DOM + Flow 生成伪代码
│  操作规划层    │  输出：伪代码操作列表
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   Runner     │  区分端类型，将伪代码转为可执行代码并执行
│  执行器层      │  输出：执行结果
└──────────────┘
```

### 4.2 各层职责

| 层 | 职责 | 输入 | 输出 |
|---|---|---|---|
| **Intention** | 意图解析 | 用户自然语言 | IntentionResult（操作流程） |
| **Scanner** | 页面扫描 | URL | ScannerResult（页面元素快照） |
| **Vector** | 向量分析 | ScannerResult | VectorResult（透传） |
| **Abstractor** | 操作规划 | IntentionResult + ScannerResult | AbstractorResult（伪代码） |
| **Runner** | 执行器 | AbstractorResult | RunnerResult（执行结果） |

### 4.3 SSE 流式输出

所有层通过 SSE（Server-Sent Events）实时流式输出事件：

```typescript
export type SSEEventType = 
  | 'start'           // 层开始
  | 'chunk'           // 数据块
  | 'tool_call'       // 工具调用
  | 'tool_result'     // 工具结果
  | 'action'          // 执行动作
  | 'screenshot'      // 截图
  | 'error'           // 错误
  | 'done'            // 完成
  | 'step_start'      // 步骤开始
  | 'step_complete'   // 步骤完成
```

---

## 五、前端集成设计

### 5.1 API 调用流程

```
前端 (React)
    │
    ├─ useTask Hook
    │   ├─ 管理消息状态
    │   ├─ 管理加载状态
    │   └─ 处理流式事件
    │
    └─ taskApi Service
        └─ submitTask(userInput, options)
            ├─ 发送 POST /api/task
            ├─ 读取 SSE 流
            ├─ 解析事件
            └─ 回调 onEvent / onError / onComplete
```

### 5.2 useTask Hook

负责管理任务执行的完整生命周期：

```typescript
const { messages, loading, handleSubmit } = useTask();

// messages: 消息列表（用户消息 + 助手消息）
// loading: 是否正在加载
// handleSubmit: 提交任务函数
```

### 5.3 taskApi Service

负责与后端通信，处理 SSE 流式响应：

```typescript
await submitTask(userInput, {
  onEvent: (event) => { /* 处理事件 */ },
  onError: (error) => { /* 处理错误 */ },
  onComplete: () => { /* 完成回调 */ },
});
```

---

## 六、后端服务设计

### 6.1 HTTP 路由

| 方法 | 路由 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| POST | `/api/task` | 提交任务，返回 SSE 流 |

### 6.2 请求/响应格式

**请求：**
```json
{
  "userInput": "帮我打开百度，搜索浏览器自动化"
}
```

**响应（SSE 流）：**
```
event: step_start
data: {"step":"intention","stepNumber":1,"message":"正在解析意图..."}

event: step_complete
data: {"step":"intention","stepNumber":1,"data":{...}}

event: action
data: {"code":"fill(searchBox, '浏览器自动化')"}

event: done
data: {"success":true,"sessionId":"..."}
```

---

## 七、代码组织原则

### 7.1 职责清晰

- **packages/engine** - 核心业务逻辑（五层架构）+ 共享常量
- **packages/ui** - UI 组件库（可复用）
- **apps/server** - HTTP 服务（路由、SSE 流转）
- **apps/web** - Web 前端（React 应用）
- **apps/extension** - 浏览器插件（同 Web 前端）

### 7.2 代码精炼

- 避免重复代码，提取公共逻辑到 `utils.ts`
- 统一 SSE 处理，避免各层重复实现
- 提取 LLM 调用逻辑，支持重试机制
- 前端 API 调用和流式处理统一在 `services/` 和 `hooks/`

### 7.3 类型安全

- 所有数据结构在 `types.ts` 中定义
- 使用 TypeScript 严格模式
- 避免 `any` 类型，使用具体类型或 `unknown`

---

## 八、启动与运行

### 开发环境

```bash
# 安装依赖
bun install
bun run playwright:install

# 启动所有服务（后端 + 前端）
bun run dev

# 或单独启动
bun run dev:server    # 后端服务
bun run dev:web       # Web 前端
bun run dev:extension # 浏览器插件
```

### 生产构建

```bash
# 构建所有应用
bun run build

# 代码检查
bun run lint
bun run typecheck
```

---

## 九、环境变量

### Web 前端 (.env)

```
VITE_API_URL=http://localhost:3000
```

### 后端服务 (.env)

```
PORT=3000
LOG_LEVEL=info
```

---

## 十、最佳实践

### 10.1 前端开发

- 使用 `useTask` hook 管理任务状态
- 使用 `taskApi` service 调用后端 API
- 在 `services/` 中集中管理 API 调用
- 在 `hooks/` 中集中管理业务逻辑

### 10.2 后端开发

- 在 `pipeline.ts` 中编排五层流水线
- 在各 `layers/` 中实现具体业务逻辑
- 使用 `createSSEStream()` 创建 SSE 流
- 使用 `logger` 记录日志

### 10.3 类型定义

- 在 `packages/engine/types.ts` 中定义所有类型
- 在 `packages/shared/constants.ts` 中定义共享常量
- 使用 `export type` 导出类型，避免运行时开销

---

## 十一、扩展指南

### 添加新的 API 端点

1. 在 `apps/server/src/index.ts` 中添加路由
2. 在 `packages/engine` 中实现业务逻辑
3. 在 `apps/web/src/services/taskApi.ts` 中添加调用

### 添加新的 UI 组件

1. 在 `packages/ui/src/components/` 中创建组件
2. 在 `packages/ui/src/components/index.ts` 中导出
3. 在应用中导入使用

### 添加新的工作区包

1. 在 `packages/` 或 `apps/` 中创建目录
2. 添加 `package.json`、`tsconfig.json`
3. 在根 `package.json` 的 `workspaces` 中注册

---

## 十二、故障排查

### 前端无法连接后端

- 检查后端是否运行：`bun run dev:server`
- 检查 API URL 配置：`.env` 中的 `VITE_API_URL`
- 检查 CORS 配置：后端已启用 CORS

### SSE 流式响应中断

- 检查网络连接
- 检查后端日志：`LOG_LEVEL=debug`
- 检查浏览器控制台错误

### 类型错误

- 运行 `bun run typecheck` 检查类型
- 确保所有类型在 `types.ts` 中定义
- 避免使用 `any` 类型

---
