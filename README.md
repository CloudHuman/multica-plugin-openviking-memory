# OpenViking Agent Memory · Multica 插件

[![CI](https://github.com/CloudHuman/multica-plugin-openviking-memory/actions/workflows/ci.yml/badge.svg)](../../actions)
[![Release](https://github.com/CloudHuman/multica-plugin-openviking-memory/actions/workflows/release.yml/badge.svg)](../../releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> 给 Multica 工作区里的智能体一套**按范围隔离的长期记忆**：任务开始前召回相关记忆，执行中随时查写，运行结束后把业务记录交给 OpenViking 蒸馏成可检索的长期记忆。
>
> Agent memory for Multica, backed by OpenViking: scoped recall before work, read/write tools during work, distilled long-term memory after work — with structural isolation between scopes.

**零 npm 依赖**（Node ≥ 20，`node src/server.mjs` 即可跑）· **只依赖公开契约**（Multica 插件系统 v1 + OpenViking REST）· **隔离不靠自觉**（key=身份，跨空间读写被存储层直接拒绝）

---

## 我们在做什么

智能体每次接到任务都是从零开始，跨任务、跨智能体的经验无处沉淀。这个插件把 OpenViking（多租户记忆库）接入 Multica：每次运行的业务输入、回复、工具调用都会被归档并蒸馏为长期记忆；下一次任务开始时，智能体能按权限召回它们——并且**只**召回它有权限看到的那些。

![架构总览](docs/diagrams/architecture.svg)

三层分工：

- **Multica**：发出事件（任务完成/评论）、把插件的工具注入给智能体、承载 skill；
- **插件服务**：验签、取材、持久化归档队列、抽取监视与自愈、范围引擎、召回合并；
- **OpenViking**：每类记忆一个独立用户空间，LLM 抽取蒸馏 + 分层索引，16 个原生 MCP 工具。

## Multica 覆盖面

功能规格 v0.5.0 的**七类使用场景全部接入**：三类在 multica 插件系统 v1 的公开事件目录内（装完即工作），四类经插件自己的版本化配套接口（`/internal/events` / `/internal/recall`）承载；`memory-*` 与 `ov-*` 工具则随安装**自动注入工作区全部智能体**。

![Multica 覆盖面](docs/diagrams/coverage.svg)

## 核心概念：范围与隔离

一个 multica 工作区 = 一个 OpenViking 账号；七类使用场景（任务协作 / 智能体公共 / 工作区共享 / 私聊配对 / 运行 / 自动化 / 委派通道）各对应一个独立用户空间。**每把 key 只能读写自己的空间**——智能体甲永远读不到乙的公共记忆，不是靠提示词约束，而是存储层直接 403。

![范围模型](docs/diagrams/scopes.svg)

| 使用场景 | 读取范围 | 归档去向 | 驱动方式 |
| --- | --- | --- | --- |
| 智能体执行普通任务 | 任务协作 + 本智能体公共 + 工作区共享 | 任务协作空间 | `task.completed` / `task.failed` 事件（开箱可用） |
| 两个智能体先后执行同一任务 | 同上（公共记忆互隔离，任务协作共享） | 同一任务协作空间，作者可区分 | 同上（开箱可用） |
| 评论 / 人类反馈 | — | 任务协作空间（peer_id 归属作者） | `comment.created`（开箱可用） |
| 私聊（人 × 智能体） | 配对空间 + 该智能体公共 + 共享 | 配对空间 | **配套 API** `chat.completed` |
| 快速创建任务（单次运行） | 运行空间 + 公共 + 共享 | 运行空间 | **配套 API** |
| 自动化 | 自动化空间 + 公共 + 共享 | 自动化空间 | **配套 API** |
| 委派交接 | 委派通道 + 接收方公共 + 运行 + 共享 | 委派通道空间 | **配套 API** `delegation.handoff` |
| 运行中追加要求 | 按新内容重新召回 | 任务协作空间（追加记录） | **配套 API** `task.input_appended` |

> Multica 插件系统 v1 的公开事件目录只有 7 个（issue/comment/task 类）。表中"配套 API"的场景由插件提供的版本化内部接口（`/internal/events`、`/internal/recall`）承载——需要 Multica 侧具备配套能力时调用，契约见下文"快速开始"第 5 步。

## 一次任务的记忆生命周期

![生命周期](docs/diagrams/lifecycle.svg)

## 智能体拿到的工具

插件安装后，工作区内**所有智能体自动**获得以下 MCP 工具（由 multica 后端签名转发，插件从签名体的 `actor.id` **可信地**获知调用者身份）：

| 工具 | 作用 | 范围 |
| --- | --- | --- |
| `memory-recall` | 语义检索，top-N 带来源（uri + scope + 内容） | **跨范围**：任务协作 + 本智能体公共 + 工作区共享 |
| `memory-remember` | 快速直写可复用结论（frontmatter 含 author_agent） | 本智能体公共记忆 |
| `memory-status` | 服务健康、归档队列进度、抽取状态分级 | — |
| `ov-search` / `ov-read` / `ov-write` / `ov-remember` / `ov-edit` / `ov-forget` / `ov-find` / `ov-list` / `ov-tree` / `ov-grep` / `ov-glob` / `ov-add-resource` / `ov-list-watches` / `ov-cancel-watch` / `ov-health` | **OpenViking 原生工具门面**：参数 schema 从实例 `tools/list` 实时镜像，调用原样转发 | **本智能体公共空间**（key=身份，结构性隔离） |

原生 `ov-remember` 走真实的"会话 + 提交 + 抽取"管道（异步生效），与 `memory-remember` 的直写通道互通——同一空间，检索都可见。门面由 `scripts/gen-ov-hooks.mjs` 按部署实例的实际工具清单生成。

**运行时差异（实测）**：OpenCode 系开箱即获得全部工具；kimi 等 ACP 运行时需先给该智能体登记一条指向其空间 key 的 workspace MCP 直连条目（workaround 手册：`docs/setup-ov-mcp.md`）；pi 运行时当前完全不下发 MCP（multica 适配器缺失，已提 [multica#8961](https://github.com/multica-ai/multica/issues/8961)）。工具调用链路的 daemon 凭据修复见 [multica#8960](https://github.com/multica-ai/multica/pull/8960)。

配套 skill（`skills/openviking-memory/SKILL.md`）随插件包安装进工作区，教智能体何时召回、何时记录、如何诚实对待"没有记忆"。

## 快速开始

分两半：**插件后端服务**（本仓库，维护者部署）+ **插件包**（≤2MiB zip，装进 multica 工作区）。

### 1. 准备 OpenViking

需要一个 OpenViking ≥ 0.4.22 实例（`create_account` / `create_user` 内联返回 key 的版本；0.4.21 亦可用，开通走 create→regenerate）。记下 `OV_BASE_URL` 和 root key（**仅用于**按工作区惰性开通账号与空间；业务读写全部走各空间自己的 key）。

### 2. 部署插件后端服务（推荐容器）

```bash
git clone https://github.com/CloudHuman/multica-plugin-openviking-memory.git
cd multica-plugin-openviking-memory

cat > deploy/.env <<'EOF'   # 0600，密钥只存在容器 env 里
OVMEM_OV_BASE_URL=https://ov.example.com
OVMEM_OV_ROOT_KEY=<ov-root-key>
OVMEM_SIGNING_SECRET=<whsec_…>        # 第 4 步轮换后回填
OVMEM_PLUGIN_TOKEN=<随机长字符串>
OVMEM_TLS_CERT=/certs/hook-server.pem # 本地联调用 dev CA 签发，见 deploy/dev-certs.sh
OVMEM_TLS_KEY=/certs/hook-server.key
EOF

docker compose -f deploy/docker-compose.yml up -d --build
```

裸机运行等价：`OVMEM_*` 环境变量 + `node src/server.mjs`（服务自带状态目录单写者锁，切勿双实例共享 state）。

### 3. 打包并安装

```bash
bash scripts/package.sh                       # 产出 dist/openviking-memory-<ver>.zip
# 自定义钩子域名: bash scripts/package.sh --url https://hooks.example.com
```

在 multica 工作区：Settings → Plugins → 上传 zip → 授权 scopes（`issues:read` / `comments:read` / `tasks:read` / `net:<钩子域名>`）→ 安装。

### 4. 轮换签名密钥并回填

安装后在插件设置里轮换 token，把响应中的 `SigningSecret`（`whsec_…`）填进 `deploy/.env` 的 `OVMEM_SIGNING_SECRET` 并重启容器。服务多个工作区时用 `OVMEM_SIGNING_SECRETS='{"<installation_id>":"whsec_…"}'` 追加。

### 5. （可选）配套能力接入

```jsonc
POST /internal/events    // Bearer OVMEM_PLUGIN_TOKEN
{ "type": "chat.completed", "version": 1, "workspace_id": "…", "delivery_id": "…",
  "payload": { "chat_ref": "…", "agent_id": "…", "user_id": "…",
               "messages": [ { "role": "user", "content": "…" } ] } }

POST /internal/recall    // 供注入方拉取召回块
{ "workspace_id": "…", "agent_id": "…", "user_id": "…", "kind": "chat", "query": "…" }
// → { entries: […], injected_block: "…" }
```

支持的 `type`：`chat.completed` / `task.input_appended` / `delegation.handoff` / `automation.started`。

## 配置参考

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `OVMEM_PORT` / `OVMEM_BIND` | `8790` / `0.0.0.0` | 监听 |
| `OVMEM_STATE_DIR` | `./state` | 状态目录（空间密钥注册表 / 队列 / 账本 / 状态日志，单写者锁保护） |
| `OVMEM_OV_BASE_URL` | — | OpenViking 地址（必填） |
| `OVMEM_OV_ROOT_KEY` | — | OV root key，仅用于开通账号/空间（必填） |
| `OVMEM_SIGNING_SECRET` | — | multica 钩子签名密钥 `whsec_…`（必填） |
| `OVMEM_SIGNING_SECRETS` | — | 多工作区安装的额外密钥映射 `{"<installation_id>":"whsec_…"}` |
| `OVMEM_PLUGIN_TOKEN` | — | `/internal` + `/admin` Bearer（必填） |
| `OVMEM_TLS_CERT` / `OVMEM_TLS_KEY` | — | HTTPS 证书 |
| `OVMEM_RECALL_ENTRIES` | `5` | 每次召回条数上限（1-10） |

multica 侧 UI 配置（随钩子请求下发，优先生效）：`recall_entries`、`include_thinking`（默认否）、`drop_tool_prefixes`（按行填写要丢弃的工具调用前缀）。

## 运维手册

**状态分级（不混淆）**：`归档成功 ≠ 抽取完成 ≠ 可检索`——`memory-status` 与 `GET /admin/status` 分别呈现（`done` / `reextracted` / `timeout` / `failed`）。

**抽取失败与恢复**：抽取依赖 LLM 配额，限流（429）或网络抖动会让抽取失败。三层自愈：

1. 归档作业指数退避重试（默认 8 次）
2. commit 后监视抽取任务，失败自动调 `POST /sessions/{id}/extract`
3. 手动兜底：`POST /admin/redrive {"scope":"…","session_id":"…"}`；共享晋升被打断时 `rm state/consolidated.json` 后重跑 `POST /admin/consolidate`

**共享空间晋升**：`POST /admin/consolidate {workspace_id}` 把各智能体公共/任务空间中可复用类别（experiences / cases / preferences / entities）的记忆经 OV 原生抽取管道晋升进共享空间（保留 promoted_from 出处，幂等）。`scripts/consolidate-nightly.sh` + `deploy/consolidate.plist` 提供每夜 03:30 定时。

**数据与安全**：`state/` 内含各空间 API key（0600）——按密钥备份与管控；OV 实例备份参考 `pg_dump + 对象存储镜像 + conf`（自包含脚本模式）。

## 与功能规格的对照与已知边界

- **运行时矩阵（实测）**：OpenCode 全工具 ✓；kimi 需直连条目解锁（机制待查）；pi 无 MCP（上游 #8961）；并发投递 ✓；跨运行时交接 ✓（oc→kimi / oc→pi）；小队分派-汇总 ✓。
- **蒸馏质量**：抽取器正确区分"谁登记的知识 / 谁执行 / 谁主张"（盲测实证）；commit 元数据带 `agent=` 归属标签；冲突记忆并存靠出处追溯，不自动裁决。
- **未实现 / 依赖上游**：私聊等配套场景需 multica 事件源；OV 0.4.21→0.4.22 生产升级需独立演练窗口；附件版本保留、多实例水平扩展未做。

## 仓库结构

```
multica.plugin.json       插件清单（4 编排钩子 + 15 ov-* 门面 + skill）
skills/openviking-memory/  智能体记忆使用规范（随 zip 安装）
docs/diagrams/            README 架构图（SVG 源）
src/                      config · hmac · multica/ov 客户端 · scopes 范围引擎
                          recall · archive · pipeline · queue · ledger
                          ov-mcp 转发 · ov-facade · consolidate · server
test/                     34 项单元/集成测试（含身份注入/隔离/自愈/幂等）
e2e/                      真实 OV 实例端到端（12/12 通过）
deploy/                   Dockerfile · compose · dev 证书 · 夜间晋升 plist
scripts/                  package.sh · gen-ov-hooks · validate-manifest
```

## 验证

```bash
node --test test/*.test.mjs        # 34/34
node scripts/validate-manifest.mjs multica.plugin.json
OV_VLM_KEY=… OV_EMBED_KEY=… node e2e/run-e2e.mjs   # 真实 OV 12/12，见 e2e/README.md
```

## 变更记录

- **0.2.x**：`ov-*` 原生工具门面（schema 实例镜像 + actor.id 注入 key）；共享记忆晋升（原生抽取管道 + 夜间定时）；多工作区签名密钥；`agent=` 归属标签；队列快照重放修复；partial→complete 自动升级；`/admin/redrive`；单写者锁；抽取监视 120s
- **0.1.0**：初始实现——七类范围引擎、归档管道、持久化队列、3 个编排工具、companion API、skill、E2E 12/12

## License

MIT（见 [LICENSE](LICENSE)）。本插件是 OpenViking REST API 的独立客户端，不修改、不分发 OpenViking 本体（OpenViking 为 AGPLv3，按需自行部署）。
