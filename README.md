# browser-hand 技术架构设计

---

## 1. 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                         前端 (React 19)                          │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐    │
│  │ 输入面板  │  │ 思维链展示│  │ 执行日志  │  │ 页面预览  │    │
│  └─────┬─────┘  └─────▲─────┘  └─────▲─────┘  └─────▲─────┘    │
│        │              │              │              │            │
│        └──────────────┴──────────────┴──────────────┘            │
│                           SSE Stream                             │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│                       Server (Hono + Bun)                        │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    Pipeline Orchestrator                  │    │
│  │  ┌─────────┬─────────┬─────────┬─────────┬─────────┐   │    │
│  │  │Intention│ Scanner │ Vector  │Abstractor│ Runner  │   │    │
│  │  │  Layer  │  Layer  │  Layer  │  Layer   │  Layer  │   │    │
│  │  └────┬────┴────┬────┴────┬────┴────┬─────┴────┬────┘   │    │
│  │       │         │         │         │          │         │    │
│  │       ▼         ▼         ▼         ▼          ▼         │    │
│  │  ┌─────────────────────────────────────────────────┐    │    │
│  │  │              Shared Context Bus                  │    │    │
│  │  └─────────────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ LLM      │  │Playwright│  │Transformer│  │  Cache   │       │
│  │ Adapter  │  │  Pool    │  │   .js     │  │  Layer   │       │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Monorepo 结构

```
browser-hand/
├── packages/
│   ├── @browser-hand/
│   │   ├── core/              # 共享类型定义、接口契约、错误体系
│   │   ├── engine/            # 五层流水线引擎（Pipeline Orchestrator）
│   │   ├── llm-adapter/       # LLM 适配层（通义千问 / DeepSeek / 本地模型）
│   │   ├── vector/            # 向量检索引擎（Transformer.js 封装）
│   │   ├── browser/           # 浏览器控制抽象层（Nodejs 实例运行 Playwright 封装）
│   │   └── utils/             # 工具库（性能监控、缓存、日志）
│   │
│   └── @browser-hand-ui/      # UI 组件库
│       ├── primitives/        # 基础原子组件
│       ├── layouts/           # 布局组件
│       └── hooks/             # 业务 Hooks（SSE、任务状态、执行流）
│
├── apps/
│   ├── server/                # Hono 后端服务（API + SSE）
│   ├── web/                   # React 19 前端应用（Vite）
│   └── cli/                   # 命令行工具
│
├── configs/                   # 共享配置预设
│   ├── eslint/
│   ├── typescript/
│   └── vitest/
│
├── turbo.json                 # Turborepo 任务编排
├── pnpm-workspace.yaml        # pnpm 工作区
└── package.json
```

### 包依赖拓扑

```
apps/server ──→ @browser-hand/engine
    │               │
    │               ├──→ @browser-hand/llm-adapter
    │               ├──→ @browser-hand/vector
    │               ├──→ @browser-hand/browser
    │               └──→ @browser-hand/core
    │
    └──→ @browser-hand/utils

apps/web ──→ @browser-hand/engine
    │
    ├──→ @browser-hand-ui/primitives
    ├──→ @browser-hand-ui/layouts
    └──→ @browser-hand-ui/hooks
```

---

## 3. 五层流水线架构

### 3.1 Pipeline 总线模型

```
                    ┌─────────────────────┐
                    │  PipelineContext     │
                    │  ─ sessionId         │
                    │  ─ abortController   │
                    │  ─ eventEmitter (SSE)│
                    │  ─ cache             │
                    │  ─ metrics           │
                    └──────────┬──────────┘
                               │
  ┌────────────────────────────▼────────────────────────────┐
  │                                                         │
  │   [Input] ──→ ┌──────────┐ ──→ ┌──────────┐ ──→ ...   │
  │               │ Stage 1  │     │ Stage 2  │             │
  │               │ validate │     │ validate │             │
  │               │ execute  │     │ execute  │             │
  │               │ emit     │     │ emit     │             │
  │               └──────────┘     └──────────┘             │
  │                                                         │
  └─────────────────────────────────────────────────────────┘
```

每层遵循统一接口：

```
interface PipelineStage<Input, Output> {
  name: string
  validate(input: Input): Result<void, ValidationError>
  execute(input: Input, ctx: PipelineContext): Promise<Output>
}
```

### 3.2 各层职责与优化策略

#### Layer 1: Intention（意图解析）

| 维度 | 设计 |
|------|------|
| **输入** | 用户自然语言字符串 |
| **输出** | `OperationPlan`（结构化步骤流） |
| **核心组件** | LLM Adapter + Prompt 模板 + Schema 校验 |
| **优化策略** | 流式解析（边生成边验证）、意图缓存（LRU）、相似问题去重 |
| **关键指标** | 首 token 延迟 < 200ms，完整解析 < 1s |

#### Layer 2: Scanner（页面扫描）

| 维度 | 设计 |
|------|------|
| **输入** | 目标 URL + 扫描策略配置 |
| **输出** | `PageSnapshot`（元素树 + 语义标注） |
| **核心组件** | Playwright Page + 注入脚本 + MutationObserver |
| **优化策略** | 增量扫描（仅变化区域）、Worker 线程隔离、智能采样（大页面分块） |
| **关键指标** | 全量扫描 < 100ms，增量扫描 < 30ms |

#### Layer 3: Vector（向量检索）

| 维度 | 设计 |
|------|------|
| **输入** | 查询文本 + 候选元素列表 |
| **输出** | 排序后的 `SearchResult[]` |
| **核心组件** | Transformer.js（本地推理） + HNSW 索引 |
| **优化策略** | 模型量化（ONNX）、SIMD 加速、分层缓存（内存 + 磁盘）、混合排序（向量 70% + 关键词 30%） |
| **关键指标** | 检索延迟 < 50ms，首次模型加载 < 3s |

#### Layer 4: Abstractor（伪代码生成）

| 维度 | 设计 |
|------|------|
| **输入** | 操作意图 + 匹配到的目标元素 |
| **输出** | `PseudoCode`（可执行的操作序列） |
| **核心组件** | LLM Adapter + 操作模板库 + 代码验证器 |
| **优化策略** | 模板优先匹配（跳过 LLM）、多候选并行生成 + 评分择优、生成后即时验证 |
| **关键指标** | 生成延迟 < 500ms，模板命中率 > 40% |

#### Layer 5: Runner（执行引擎）

| 维度 | 设计 |
|------|------|
| **输入** | `PseudoCode` |
| **输出** | `ExecutionResult`（截图 / 状态 / 错误） |
| **核心组件** | Playwright 浏览器连接池 + 操作解析器 |
| **优化策略** | 连接池复用、操作合并批处理、无依赖并行执行、智能重试（指数退避） |
| **关键指标** | 单步操作 < 200ms，池化实例复用率 > 80% |

---

## 5. 技术栈选型

| 领域 | 选型 | 理由 |
|------|------|------|
| **运行时** | Bun | 原生 TS、极速启动、SIMD 支持 |
| **构建** | Turborepo + pnpm | Monorepo 原生支持、远程缓存 |
| **包打包** | tsup | ESM 优先、tree-shaking |
| **前端框架** | React 19 | Server Components、`use()` hook、Suspense |
| **前端构建** | Vite + SWC | HMR 极速、SWC 替代 Babel |
| **后端框架** | Hono | 轻量、边缘友好、原生 SSE |
| **LLM** | 通义千问 (DashScope) | 中文优化、OpenAI 兼容协议 |
| **向量引擎** | Transformer.js | 浏览器/Node 双端、本地推理 |
| **向量索引** | HNSW | 高维近似最近邻、O(logN) 查找 |
| **浏览器控制** | Playwright | 跨浏览器、稳定 API |
| **状态管理** | Zustand + React Query | 轻量 + 服务端缓存 |
| **类型校验** | Zod | 运行时 + 编译时双重校验 |
| **测试** | Vitest | 原生 ESM、兼容 Jest |
| **代码规范** | Biome | 比 ESLint+Prettier 快 35x |

---

## 6. 关键设计决策

### 6.1 浏览器实例管理

```
┌─────────────────────────────┐
│       BrowserPool           │
│  ┌─────┐ ┌─────┐ ┌─────┐  │
│  │ Ctx1 │ │ Ctx2 │ │ Ctx3 │  │  ← 最大并发数（默认 3）
│  └──┬──┘ └──┬──┘ └──┬──┘  │
│     │       │       │      │
│     └───────┼───────┘      │
│             ▼              │
│      Browser Instance      │  ← 单实例多上下文隔离
└─────────────────────────────┘
```

- 单 Browser 实例 + 多 BrowserContext（隔离会话）
- 连接池自动扩缩，空闲超时回收
- 异常断连自动重建

### 6.2 缓存策略

```
L1: 内存缓存（LRU, TTL 5min）
  │ 命中 → 直接返回
  ▼
L2: 磁盘缓存（.cache/, TTL 24h）
  │ 命中 → 加载并回填 L1
  ▼
L3: 原始计算
  │ 结果 → 回填 L2 + L1
```

缓存对象：
- 意图解析结果（按输入文本 hash）
- 页面元素向量（按 URL + DOM hash）
- LLM 响应（按 prompt hash）

### 6.3 容错与重试

```
错误分类:
├── 可重试（网络超时、LLM 限流）     → 指数退避，最多 3 次
├── 可降级（向量检索失败）            → 回退到关键词匹配
├── 需中断（用户取消、权限错误）      → 立即终止，清理资源
└── 不可恢复（页面结构剧变）          → 通知用户，建议重新扫描
```