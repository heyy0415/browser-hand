# browser-hand 技术设计

---

## 一、项目概述

browser-hand 是一个浏览器自动化引擎，用户通过自然语言输入操控网站。系统通过五层流水线架构（intention → scanner → vector → abstractor → runner）将自然语言转化为可执行的浏览器操作，针对 Token 消耗、准确率、速度三个维度做了全面提升。

---

## 二、技术选型

| 类别 | 选型 | 说明 |
|---|---|---|
| 前端 | React |
| 运行时 | Bun（主）+ Node.js（Playwright 层） | Bun 兼容 Playwright 有 Windows 问题，Playwright 执行层用 Node.js |
| 语言 | TypeScript | 全项目统一 |
| 样式 | Tailwind CSS | Web 页面端和插件 UI |
| 代码规范 | ESLint + Husky | Git commit 拦截检测 |
| AI 调用 | LangChain | Intention / Abstractor 层调用 LLM |
| 浏览器控制 | Playwright | Web 页面端无头浏览器执行 |
| 通信协议 | SSE | 五层架构流式输出 |
| 包管理 | Bun | bun install / bun run |

---

## 三、项目结构

```
browser-hand/
├── packages/
│   │
│   ├── engine/                     # 核心引擎
│   │   ├── index.ts                # 统一导出
│   │   ├── types.ts                # 全部类型
│   │   ├── pipeline.ts             # SSE 流水线
│   │   ├── prompts.ts              # 全部提示词
│   │   ├── utils.ts                # SSE + Logger
│   │   └── layers/
│   │       ├── intention.ts
│   │       ├── scanner.ts
│   │       ├── vector.ts
│   │       ├── abstractor.ts
│   │       └── runner.ts
│   │
│   └── shared/
│       └── constant.ts #用于存放intention层和abstractor层的prompt以及longchain的agent配置。
│
├── apps/
    │
    ├── web-extension/ #浏览器插件端
    │
    ├── web-page/      #网页端
    │
    └── server/        #后端服务/api/task


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

```bash
# 安装 husky
bun add -d husky lint-staged
bunx husky init
```

```bash
# .husky/pre-commit
bunx lint-staged
```

---

## 九、启动与运行

### 开发环境

```bash
# 安装依赖
bun install
bun run playwright:install

# 启动所有服务（后端 + Playwright Worker + 前端）
bun run dev:all
```

### 单独启动

```bash
# 后端服务（Bun）
bun run dev:server

# Playwright Worker（Node.js）
bun run dev:worker

# Web 前端
bun run dev:web

# 浏览器插件
bun run dev:extension
```

### 生产构建

```bash
bun run build
bun run lint
```

---