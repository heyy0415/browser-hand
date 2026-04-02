# browser-hand

> **用自然语言操控浏览器 —— 告诉它你要做什么，它自己搞定。**

一句话描述你的需求，browser-hand 自动理解意图、定位元素、执行操作。全程思考可见，全程本地优先。

---

## ✨ 核心特性

- **自然语言驱动** - 无需写代码，用中文描述你要做的事
- **智能元素定位** - Transformer.js 本地向量检索 + 语义匹配
- **实时执行反馈** - SSE 流式输出，每一步思考过程透明可见
- **完整页面扫描** - 自动发现所有可见可交互元素并标注语义
- **本地模型优先** - 向量检索完全本地运行，无需额外 API 调用

---

## 🏗️ 技术架构

### 整体结构

```
browser-hand/
├── packages/           # 核心引擎 @browser-hand/engine
│   ├── layers/         # 五层流水线
│   └── utils/          # 共享类型与工具
├── apps/
│   ├── server/         # Hono 后端 + SSE 接口
│   └── web/            # React 前端交互界面
└── scripts/            # 构建脚本
```

### 五层流水线

```
用户输入: "打开百度，搜索 AI 新闻"
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  Intention   │  LLM 解析意图 → 结构化操作步骤流             │
├─────────────────────────────────────────────────────────────┤
│  Scanner     │  Playwright 扫描页面 → 元素快照 + 语义标注   │
├─────────────────────────────────────────────────────────────┤
│  Vector      │  Transformer.js 本地向量检索 → 筛选相关元素  │
├─────────────────────────────────────────────────────────────┤
│  Abstractor  │  LLM 生成伪代码 → click / fill / navigate    │
├─────────────────────────────────────────────────────────────┤
│  Runner      │  解析伪代码 → Playwright 执行 → 返回结果     │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
执行结果（SSE 实时推送到前端）
```

每一层通过 Pipeline 串联，各层产出通过 SSE 事件实时推送到前端。

### 数据流

```
前端 ←SSE← Server ←Pipeline← Runner ← Abstractor ← Vector ← Scanner ← Intention ← 用户输入
```

### 技术栈

| 模块 | 技术 |
|------|------|
| 运行时 | Bun |
| LLM | 通义千问 (DashScope API) |
| 向量检索 | Transformer.js (本地运行) |
| 浏览器自动化 | Playwright (Chromium) |
| 后端 | Hono + SSE |
| 前端 | React 19 + Vite |
| 类型系统 | TypeScript (strict mode) |

---

## 🚀 快速上手

### 环境要求

- [Bun](https://bun.sh/) >= 1.0
- Node.js（用于安装 Playwright 浏览器）

### 安装

```bash
# 1. 克隆项目
git clone https://github.com/your-repo/browser-hand.git
cd browser-hand

# 2. 安装依赖
bun install

# 3. 安装 Playwright 浏览器
npx playwright install chromium
```

### 启动

```bash
bun run dev
```

启动后访问：
- **Web 界面**: http://localhost:5173
- **API 服务**: http://localhost:3000

### API 调用

```bash
curl -N -X POST "http://localhost:3000/api/task" \
  -H "Content-Type: application/json" \
  -d '{"question": "打开淘宝，搜索机械键盘", "headless": false}'
```

### 命令速查

```bash
bun run dev        # 启动开发服务
bun run typecheck  # 类型检查
bun run build      # 构建前端
bun run test       # 运行测试
```

---

## 🔧 工作原理

### Vector 层 - 本地向量检索

Vector 层使用 **Transformer.js** 在 Bun 服务端本地运行：

- 模型：`Xenova/paraphrase-multilingual-MiniLM-L12-v2`（支持中文）
- 向量维度：384
- 混合检索：向量相似度(70%) + 关键词匹配(30%)
- 首次运行自动下载模型到 `.model-cache/`（约 400MB）

---

## 📄 License

MIT
