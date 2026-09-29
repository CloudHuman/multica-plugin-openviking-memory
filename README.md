# OpenViking Agent Memory — Multica 插件

[![CI](https://github.com/CloudHuman/multica-plugin-openviking-memory/actions/workflows/ci.yml/badge.svg)](../../actions)
[![Release](https://github.com/CloudHuman/multica-plugin-openviking-memory/actions/workflows/release.yml/badge.svg)](../../releases)

让 Multica 工作区里的智能体拥有**按范围隔离的长期记忆**：任务开始前召回相关记忆、执行中主动查写、运行结束后把业务记录归档进 OpenViking 抽取为可检索的长期记忆。

- **零 npm 运行时依赖**：纯 Node（≥20）实现，`node src/server.mjs` 即可运行
- **结构性隔离**：记忆范围映射到 OpenViking 原生多租户 user 空间——一把 key 只能读写自己的空间，越权在存储层就不可能
- **只依赖公开契约**：插件侧只用 Multica 插件系统 v1 的公开面（HMAC 签名钩子、callback API、skill 资源）与 OpenViking REST API

```
收到的每个事件 ──HMAC验签──▶ 快速取材(callback API, token 5min TTL)
        │
        ▼
   持久化队列 ──断点续传──▶ OV session(parts模式消息) ──commit──▶ LLM 抽取
        │                                                    │ 抽取失败→自动重提取
        ▼                                                    ▼
   账本去重(重复投递不重复归档)                        长期记忆(可语义检索)
                                                               ▲
智能体工具 memory-recall / remember / status ──范围解析──▶ 多空间合并检索 top-5 带来源
```

## 功能矩阵

对照《Multica 记忆插件功能说明》的使用场景表：

| 使用场景 | 读取范围 | 归档去向 | 驱动方式 |
| --- | --- | --- | --- |
| 智能体执行普通公共任务 | 任务协作 + 本智能体公共 + 工作区共享 | 任务协作空间 | `task.completed`/`task.failed` 事件（开箱可用） |
| 两个智能体先后执行同一任务 | 同上（各自公共记忆隔离，任务协作共享） | 同一任务协作空间，作者可区分 | 同上（开箱可用） |
| 评论/人类反馈 | — | 任务协作空间（`peer_id` 归属作者） | `comment.created` 事件（开箱可用） |
| 私聊（人×智能体） | 配对空间 + 该智能体公共 + 共享 | 配对空间（`dm:{ws}:{agent}:{user}`） | **配套 API** `chat.completed` |
| 快速创建任务（单次运行） | 运行空间 + 公共 + 共享 | 运行空间 | **配套 API** |
| 自动化 | 自动化空间 + 公共 + 共享 | 自动化空间 | **配套 API** |
| 委派交接 | 委派通道 + 接收方公共 + 运行 + 共享 | 委派通道空间 | **配套 API** `delegation.handoff` |
| 运行中追加要求 | 按新内容重新召回 | 任务协作空间（追加记录） | **配套 API** `task.input_appended` |

> **说明**：Multica 插件系统 v1 的公开事件目录只有 7 个事件（issue/comment/task 类），**没有**聊天消息、自动化触发、委派、运行中追加这类事件。上表中"配套 API"的场景由本插件提供的版本化内部接口（`/internal/events`、`/internal/recall`，见下文）承载——需要 Multica 侧具备配套能力（例如携带这些事件的构建）时调用；在此之前可用任何调度方（脚本、自动化平台）按同样契约投递。这与功能说明中"当前版本依赖配套的 Multica 能力"的表述一致。

### 智能体可用的工具

插件通过 `agent` 触发钩子向智能体提供 3 个辅助工具（Multica 会把它们合成为 MCP 工具，调用时由 Multica 后端签名转发，插件从签名的请求体中**可信地**获知执行智能体身份）：

| 工具 | 作用 |
| --- | --- |
| `memory-recall` | 在获准范围内语义检索记忆，返回 top-N 带来源（uri + scope + 内容） |
| `memory-remember` | 把可复用结论写入**本智能体公共记忆**（frontmatter 含作者与来源标记） |
| `memory-status` | 服务健康、归档队列进度、最近归档的抽取状态（归档成功 ≠ 抽取完成 ≠ 产生可用记忆，分别可见） |

OpenViking 原生的 16 个 MCP 工具（`find/search/read/remember/write/…/add_skill`）由 OV 自身提供：在工作区 MCP 配置中为每个智能体登记指向 OV `/mcp` 的条目并嵌入该智能体公共空间的 key 即可，插件仓库的 `docs/` 提供操作说明。配套 skill（`skills/openviking-memory/SKILL.md`）随插件包安装进工作区，教智能体何时召回、何时记录、如何诚实对待"没有记忆"。

## 安装

分两半：**插件后端服务**（本仓库，维护者部署）+ **插件包**（≤2MiB zip，装进 Multica 工作区）。

### 1. 准备 OpenViking

需要一个 OpenViking ≥0.4.22 实例（`create_account`/`create_user` 内联返回 key 的版本）。记下：

- `OV_BASE_URL`（如 `https://ov.example.com`）
- root key（**只用于**按工作区惰性开通账号与用户空间；业务读写全部走各空间自己的 key）

### 2. 部署插件后端服务

```bash
git clone https://github.com/CloudHuman/multica-plugin-openviking-memory.git
cd multica-plugin-openviking-memory

export OVMEM_OV_BASE_URL=https://ov.example.com
export OVMEM_OV_ROOT_KEY=<ov-root-key>
export OVMEM_SIGNING_SECRET=<whsec_…>      # 安装插件后轮换 token 获得，见第 4 步
export OVMEM_PLUGIN_TOKEN=<随机长字符串>    # 守护 /internal 与 /admin 端点
node src/server.mjs
# 或 docker compose -f deploy/docker-compose.yml up -d --build
```

服务监听 `:8790`。生产部署需真实 HTTPS（反代或 `OVMEM_TLS_CERT/OVMEM_TLS_KEY`）；本地与容器化 multica 联调见 `deploy/dev-certs.sh`（用 multica 的 plugin dev CA 签一张 `host.docker.internal` 证书）。

### 3. 打包并安装插件

```bash
bash scripts/package.sh                 # 产出 dist/openviking-memory-<ver>.zip
# 自定义钩子域名（默认 host.docker.internal:8790）:
# bash scripts/package.sh --url https://hooks.example.com
```

在 Multica 工作区：Settings → Plugins → 上传 zip → 授权 scopes（`issues:read`、`comments:read`、`tasks:read`、`net:<你的钩子域名>`）→ 安装。

### 4. 轮换签名密钥并配置服务

安装后（或任何时候）在工作区插件设置里轮换 token，响应里的 `SigningSecret`（`whsec_…`）填入服务的 `OVMEM_SIGNING_SECRET`，然后重启服务。

### 5. （配套能力，可选）接入内部事件

Multica 构建若携带记忆配套能力，向以下端点投递（Bearer `OVMEM_PLUGIN_TOKEN`）：

```jsonc
POST /internal/events
{ "type": "chat.completed", "version": 1, "workspace_id": "…",
  "delivery_id": "…",                       // 幂等键
  "payload": { "chat_ref": "…", "agent_id": "…", "user_id": "…",
               "messages": [ { "role": "user", "content": "…" }, … ] } }

POST /internal/recall                        // 领取/注入时取召回块
{ "workspace_id": "…", "agent_id": "…", "user_id": "…", "kind": "chat",
  "query": "…" }                             // → { entries: […], injected_block: "…" }
```

支持的 `type`：`chat.completed`、`task.input_appended`、`delegation.handoff`、`automation.started`。`kind` ∈ `task|chat|run|automation|delegation` 决定召回范围矩阵。

## 配置参考

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `OVMEM_PORT` / `OVMEM_BIND` | `8790` / `0.0.0.0` | 监听 |
| `OVMEM_STATE_DIR` | `./state` | 状态目录（密钥注册表/队列/账本/状态日志） |
| `OVMEM_OV_BASE_URL` | — | OpenViking 地址（必填） |
| `OVMEM_OV_ROOT_KEY` | — | OV root key，仅用于开通账号/空间（必填） |
| `OVMEM_SIGNING_SECRET` | — | multica 钩子签名密钥 `whsec_…`（必填） |
| `OVMEM_PLUGIN_TOKEN` | — | `/internal`+`/admin` Bearer（必填） |
| `OVMEM_TLS_CERT` / `OVMEM_TLS_KEY` | — | HTTPS 证书 |
| `OVMEM_RECALL_ENTRIES` | `5` | 每次召回条数上限（1-10） |

Multica 侧 UI 配置（随钩子请求下发，优先生效）：`recall_entries`（召回条数）、`include_thinking`（是否归档 thinking 作为蒸馏养料，默认否）、`drop_tool_prefixes`（按行填写要丢弃的工具调用前缀，如 `multica issue list`）。

## 范围模型与安全

- **一个 multica 工作区 = 一个 OV 账号**；每类记忆范围 = 账号下一个 OV user 空间，id 由范围键哈希**确定性**导出（注册表丢失也可凭 root key 重建）。
- 每次召回只查询当前场景获准的空间集合（范围矩阵在 `src/scopes.mjs`，有单测钉死）；跨空间读取被 OV 以 403 拒绝——隔离不靠插件自觉。
- 钩子验签：`HMAC-SHA256(key, "ts.body")`，±5 分钟时间窗，常数时间比较；验签失败一律 401。
- 归档卫生：系统提示/运行时简报/内部思考默认不进入蒸馏输入；探针类工具调用可配置丢弃；重复投递按 `invocation_id`+账本去重；同一运行重复归档被会话幂等（409 容忍）与作业去重键双重防护。
- 抽取失败自愈：commit 后监视抽取任务，失败（如 429 被吞成终态）自动按退避调用 `POST /sessions/{id}/extract` 重提取，重试与恢复状态可在 `memory-status`/`/admin/status` 看到。
- `state/` 内含各空间 API key（0600 权限）——备份与访问控制按密钥对待；仓库 `.gitignore` 已排除。

## 验证

```bash
node --test test/*.test.mjs        # 单元 + 集成（mock OV / mock multica，29 项）
node scripts/validate-manifest.mjs multica.plugin.json
OV_VLM_KEY=… OV_EMBED_KEY=… node e2e/run-e2e.mjs   # 真实 OV 实例端到端（见 e2e/README.md）
```

E2E 覆盖：事件验签→取材→归档→**真实 LLM 抽取**→语义命中→工具召回→主动记录→评论归属→私聊配对空间→跨空间隔离(403)→跨智能体不可见→重复投递去重→状态上报。

## 从 GitHub 分发

- 打 tag（`vX.Y.Z`）→ CI 跑测试 → 自动构建 `dist/openviking-memory-X.Y.Z.zip` 并附到 GitHub Release
- 安装方：`gh release download -R CloudHuman/multica-plugin-openviking-memory -p 'openviking-memory-*.zip'` 或从 Release 页下载，经工作区 Settings → Plugins 安装
- 版本号与 `multica.plugin.json` 的 `version` 保持一致（打包脚本用 tag 覆写）
- 插件 key：`io.github.cloudhuman.openviking-memory`（反向域名，避免与其他插件冲突）

## 仓库结构

```
multica.plugin.json     插件清单（4 钩子 + 1 skill 资源）
skills/openviking-memory/SKILL.md   智能体记忆使用规范（随 zip 安装）
src/
  server.mjs            HTTP(S) 服务与路由（hooks / internal / admin / healthz）
  hmac.mjs              multica 钩子签名验证
  multica-client.mjs    callback API 客户端（context/issue/comments/任务消息）
  ov-client.mjs         OpenViking REST 客户端（ provisioning/sessions/search/content ）
  scopes.mjs            范围引擎：场景矩阵 → OV 多租户映射 + 惰性开通 + 注册表
  recall.mjs            多空间召回：合并/去 stub/排序/top-N/来源保留
  archive.mjs           事件 → OV parts 消息的纯构建器（归档卫生规则）
  pipeline.mjs          归档执行器：断点续传 + 抽取监视 + 自动重提取
  queue.mjs             持久化作业队列（journal 重放、退避重试、重启恢复）
  ledger.mjs            投递账本（幂等）+ 归档状态日志
test/                   29 项单元/集成测试
e2e/                    真实 OV 实例端到端（run-e2e.mjs + ov-boot.sh）
deploy/                 Dockerfile / compose / dev 证书脚本
scripts/                package.sh（打包）+ validate-manifest.mjs（离线校验）
```

## 已知限制

- **配套场景依赖配套能力**：私聊/追加/自动化/委派的自动归档需要 Multica 侧事件（内部 API 已就绪并测试，契约见上）；纯公开契约下这些场景只能由外部调度方驱动。
- **transcript 端点**：`/v1/tasks/{id}/messages` 在 Multica main 分支尚不存在（上游 PR #8914）；无此端点的构建中，任务归档降级为"issue 正文 + 评论"并在状态中明确标记 `partial`。
- 记忆质量依赖 OV 抽取模型；冲突/过期结论的处理沿用 OV 语义（作者与来源可追溯，不自动裁决）。
- 附件版本保留、多实例部署（水平扩展需共享 state 或改用外部队列）未实现。

## License

MIT（见 [LICENSE](LICENSE)）。本插件是 OpenViking REST API 的独立客户端，不修改、不分发 OpenViking 本体（OpenViking 为 AGPLv3，按需自行部署）。
