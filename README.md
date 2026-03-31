# browser-hand

一个基于五层流水线的浏览器自动化引擎：将自然语言任务转换为 Playwright 可执行动作。

## 技术架构

### Monorepo 结构

- `packages/engine`：核心流水线引擎
- `apps/server`：Hono 后端，暴露 `/api/task` SSE 接口
- `apps/web`：React 前端

### 五层流水线

1. **intention**
   - 输入：用户自然语言
   - 输出：结构化 `flow`（action/target/desc）

2. **scanner**
   - 通过 Node.js 子进程运行 Playwright 扫描目标页面
   - 输出：页面元素快照（`ScannerResult`）

3. **vector**
   - 当前默认透传扫描结果
   - 输出：`success: true` 的向量层结果

4. **abstractor**
   - 将意图步骤映射为伪代码（如 `click('selector')` / `fill('selector', 'text')`）

5. **runner**
   - 将 abstractor 伪代码转换为 Playwright 调用并执行
   - 支持有头 / 无头模式

### 共享模块（engine/shared）

`packages/engine/shared` 仅保留三个文件：

- `constant.ts`：配置与提示词
- `util.ts`：LLM、SSE、日志、解析工具
- `type.ts`：全局类型定义

项目内通过别名导入：`@@browser-hand/engine-shared/*`

### API 说明

`POST /api/task`

请求体：

```json
{
  "question": "打开 https://example.com 并点击更多信息",
  "headless": true
}
```

- `headless`：控制 runner 层是无头模式（`true`）还是有头模式（`false`）
- 返回：SSE 事件流（start / delta / completed / error / done）

---

## 快速上手

### 1) 安装依赖

```bash
bun install
```

### 2) 安装 Playwright 浏览器

```bash
npx playwright install chromium
```

### 3) 启动服务

```bash
bun run dev
```

默认：

- Server: `http://localhost:3000`
- Web: `http://localhost:5173`

### 4) 调用任务接口

```bash
curl -N -X POST "http://localhost:3000/api/task" \
  -H "Content-Type: application/json" \
  -d '{"question":"打开 https://example.com","headless":true}'
```

### 5) 类型检查

```bash
bun run typecheck
```
