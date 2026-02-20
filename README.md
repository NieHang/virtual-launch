# Virtual Launch Analytics

一个用于 Base 链 Virtuals 项目的实时分析系统，包含：

- 后端 indexer + API（Fastify + Drizzle + SQLite）
- 前端可视化面板（Next.js）
- 交易、税收、鲸鱼、EFDV、回购模拟等分析能力

## 目录结构

- `src/`：后端服务、链上抓取、指标计算
- `web/`：前端应用
- `scripts/`：运维和数据修复脚本
- `data/`：SQLite 数据文件（默认）

## 运行环境

- Node.js 18+（建议 20+）
- npm 9+
- 可访问 Base RPC 的网络环境

## 1) 安装依赖

在项目根目录执行：

```bash
npm install
cd web && npm install
```

## 2) 配置环境变量

复制配置模板：

```bash
cp .env.example .env
```

常用配置项（见 `.env.example`）：

- `RPC_URL`：Base RPC 地址
- `PORT`：后端端口（默认 `3001`）
- `DB_PATH`：数据库路径（默认 `./data/virtual-launch.db`）
- `POLL_INTERVAL_MS`：索引轮询间隔
- `CONFIRMATIONS`：确认块数
- `BUYBACK_EXECUTOR_ADDRESS`：回购执行地址

前端默认走相对路径 `/api`，由 `web/next.config.mjs` 代理到后端。  
如需直连后端，可在前端环境里配置：

- `NEXT_PUBLIC_API_URL=http://127.0.0.1:3001`

## 3) 启动服务

### 启动后端（根目录）

开发模式（带 watch）：

```bash
npm run dev
```

或生产启动：

```bash
npm run start
```

后端默认监听：`http://127.0.0.1:3001`

### 启动前端（`web/` 目录）

```bash
npm run dev
```

前端默认地址：`http://127.0.0.1:3000`

## 4) 添加项目并开始索引

先确保后端在运行，然后在根目录执行：

```bash
npm run add-project <token_address> [name]
```

示例：

```bash
npm run add-project 0x1234...abcd "My Token"
```

执行后会写入项目信息；后端会初始化并进入索引循环。

## 5) 常用命令

根目录：

- `npm run db:push`：推送数据库 schema
- `npm run db:generate`：生成迁移
- `npm run verify-tax`：税收校验
- `npm run backfill-internal-trades`：回补 internal trades
- `npm run rebuild-internal-trades`：重建 internal trades
- `npm run rebuild-tax-inflows`：重建 tax inflows
- `npm run model:train-threshold`：训练阈值模型
- `npm run model:backtest-threshold`：回测阈值模型

## 6) API 快速检查

健康检查可以直接请求项目接口，例如：

```bash
curl "http://127.0.0.1:3001/projects"
curl "http://127.0.0.1:3001/projects/<projectId>/state"
```

## 7) EFDV Calculator（Base FDV 可自定义）

现在 EFDV Layers 面板支持自定义 `Base FDV (V)` 输入，不再固定 42000：

- 默认值：`42000`
- 输入任意正数（例如 `40000`）后会实时重新计算 layers
- 输入无效值时，后端会返回 `400`，前端会回退显示默认逻辑

对应 API：

```bash
curl "http://127.0.0.1:3001/projects/<projectId>/efdv/layers?mode=prelaunch&baseFdvVirtual=40000"
```

## 8) 常见问题

### Q1: 页面数值看起来没更新

- 确认后端是否在你预期端口运行（默认 `3001`）
- 确认前端是否连到了正确后端（代理或 `NEXT_PUBLIC_API_URL`）
- 重启后端和前端后再刷新页面

### Q2: 出现 `EADDRINUSE`

说明端口已被占用。可以：

- 结束占用进程，或
- 临时换端口启动：

```bash
PORT=3101 npm run start
```

并同步调整前端 API 地址或代理目标。

### Q3: RPC 超时或索引慢

- 换更稳定的 `RPC_URL`
- 适当调大 `POLL_INTERVAL_MS`
- 保持网络稳定，避免代理中断

## 9) 数据文件说明

默认数据库在：

- `./data/virtual-launch.db`

如需多环境隔离，请通过 `DB_PATH` 指向不同文件。

## 10) 开发建议

- 新功能优先在 `npm run dev` 下联调
- 涉及指标变更时，先用 API 验证数值再看 UI
- 生产前建议备份 `data/` 目录
