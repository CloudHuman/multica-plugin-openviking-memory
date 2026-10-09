# Multica 补丁

插件按 Multica 插件系统 v1 的公开契约编写，原版 Multica 也能安装，但有几处缺口。这里的 5 个补丁补上这些缺口，由本仓库维护，不提交到 multica-ai/multica。

## 一览

| 补丁 | 解决什么 | 不打会怎样 | 依赖 |
| --- | --- | --- | --- |
| [0001](0001-feat-plugins-task-read-API-and-run-context-for-agent.patch) 任务读取 API 与运行上下文 | 插件能读到运行的类型、触发输入和转写；工具调用带上是哪次运行 | issue 运行只归档收尾评论；私聊、快速创建、自动化、委派不归档；`memory-recall` 不绑定运行 | — |
| [0002](0002-fix-plugins-daemon-credential-for-hook-only-tasks.patch) 只有插件工具时也签发 daemon 凭据 | 真实 daemon 上的插件工具鉴权 | 运行里没有远程 MCP 连接时，插件工具调用返回 401 | — |
| [0003](0003-fix-plugins-quick-create-kind-after-issue-linking.patch) 快速创建关联 issue 后保留运行类型 | 快速创建的运行建出 issue 后仍按快速创建归档 | 归档离开开始召回时用的 run 空间，并漏掉成员的快速创建提示 | 0001 |
| [0004](0004-feat-recover-confirmed-final-delivery.patch) 确认已发布的交付 | 最终评论已发布、收尾却失败时，成员确认后复用已有交付 | 这类运行只能重跑 | — |
| [0005](0005-fix-comments-stop-an-agent-s-own-mention-from-re-que.patch) 同一 issue 上不自我派发 | 智能体照抄指向自己的 mention 时不再派发自己 | 反复派发自己，插件反复归档、抽取同一段循环（实测 13 分钟多跑 31 次） | — |

几个共同点：

- **只改服务端**：都是 Go 代码；0001 另有授权页上 `chats:read` 的说明文案（5 种语言），不重新构建前端也不影响功能。
- **没有数据库迁移**：0001、0004 只新增 sqlc 查询。
- **daemon 和 CLI 不变**：智能体所在机器不用升级。

**推荐全部应用**，按编号顺序。只打一部分时：0003 依赖 0001，其余互不依赖；要用插件工具至少打 0002，要归档运行、绑定召回再打 0001。

## 应用、构建与验证

```bash
cd <multica 仓库>
git checkout <你部署的版本>
git am <本仓库>/upstream/multica/0*.patch
cd server && go build ./... && go vet ./internal/handler/ ./internal/service/

# 补丁自带测试（需要已迁移的测试库：go run ./cmd/migrate up）
DATABASE_URL=postgres://…/multica_test go test ./internal/handler/ -run 'PluginTask|PluginChatRun|AgentHook' -count=1
DATABASE_URL=postgres://…/multica_test go test ./internal/service/ -run TestTaskIDFromPayloadOnlyReadsTheRunItReportsOn -count=1
DATABASE_URL=postgres://…/multica_test go test ./internal/handler/ -run 'TestRemoteMCPDaemonTokenForClaim|TestPluginHookOnlyClaimHasDaemonCredential' -count=1
DATABASE_URL=postgres://…/multica_test go test ./internal/handler/ -run TestPluginTaskQuickCreateKeepsOriginAfterCreatingIssue -count=1
DATABASE_URL=postgres://…/multica_test go test -race ./internal/handler/ -run TestRecoverTaskDelivery -count=1
DATABASE_URL=postgres://…/multica_test go test ./internal/handler/ -run AgentSelfMention -count=1
```

然后按原来的方式重新构建、部署 Multica 服务端。插件包用 `bash scripts/package.sh --with-chats-read …` 构建，安装时授予 `chats:read`，私聊运行才会被归档；原版 Multica 会拒绝带 `chats:read` 的清单，所以默认包不带它。

**已验证的基线**：

| Multica 版本 | 验证内容 |
| --- | --- |
| `e31da86`（2026-09-30） | 0001 干净应用，`go build` / `go vet` 通过，0001 的 10 个测试通过；真实 Multica 跑 `e2e/real-stack/`，补丁版与原版各 12/12（见 `reports/e2e-2026-09-30.md`） |
| `43b0571` | 真实智能体验证所用的服务端；第二轮独立评审在此应用全部 5 个补丁，编译、`go vet` 和补丁测试通过 |
| `10a7e51`（2026-10-09 的 main） | 全部 5 个补丁干净应用，`go build` / `go vet` 通过，补丁测试 18 个全部通过 |

## 维护方式

部署和升级 Multica 时，按编号顺序重新应用，并跑一遍补丁自带的测试。补丁按 multica 的公开 API 约定编写（problem+json 错误、不透明游标、`DefaultPageSize` / `MaxPageSize`、scope 目录），冲突时以这些约定为准调整。

## 没有补丁时（原版 Multica）

| 能力 | 补丁版 | 原版 |
| --- | --- | --- |
| issue 运行归档 | 转写 + 触发输入完整归档到任务协作空间 | 读不到转写：运行事件以 200 跳过；运行的**收尾评论**作为智能体陈述归档 |
| 私聊 / 自动化 / 快速创建 / 委派运行 | 按 kind 归档到配对 / 自动化 / 运行 / 委派通道空间 | 以 200 跳过（不触发 multica 熔断）；私聊可改走配套 API `/internal/events` |
| `memory-recall` | 绑定到调用它的运行，模型给出的其他 `issue_id` 被忽略 | 不知道调用方是哪次运行：检索本智能体公共 + 共享，外加模型指定的 issue（multica 本身也允许智能体读工作区内任意 issue） |
| 插件工具（`memory-*`、`ov-*`） | ✓ | 真实 daemon 上，运行里没有远程 MCP 连接时返回 401（0002 修复） |
| 评论归档、共享晋升、租户隔离、抽取自愈 | ✓ | ✓ |

## 各补丁细节

### 0001 任务读取 API 与运行上下文

`0001-feat-plugins-task-read-API-and-run-context-for-agent.patch` 补上插件系统 v1 的一处缺口：插件能收到 `task.completed`，却读不到**这次运行里发生了什么**；智能体调用插件工具时，插件也不知道**是哪一次运行在调用**。补丁新增任务读取接口，并在工具钩子里带上运行上下文。

#### 0001 的接口

| 变更 | 说明 |
| --- | --- |
| `GET /v1/tasks/{task_id}` | 运行本身（kind：issue / chat / autopilot / quick_create / other，关联的 issue / 私聊 / 自动化，attempt，状态）+ 触发它的输入（私聊消息、触发评论、快速创建提示、委派交接），每类输入各自受读权限约束 |
| `GET /v1/tasks/{task_id}/messages` | 运行转写，不透明游标分页（`cursor` / `next_cursor`，默认 50、上限 200 条），超长字段按 32 KiB 在字符边界截断 |
| 新 scope `chats:read` | 私聊运行的输入与转写是私人对话，`tasks:read` 单独不可读；需安装时额外授权 |
| 智能体工具钩子携带运行上下文 | 钩子请求体带 `task_id` / `issue_id`，取自被认领的任务行（不是模型给的）；该次回调凭据的**任务读取**被收窄到这一次运行，issue 读取范围不变 |
| 任务事件收窄凭据 | `task.*` 事件的回调凭据只能读它所报告的那一次运行 |

另含：两条 sqlc 查询（`ListTaskMessagesPage`、`ListUserChatMessagesByTask`）及生成代码、OpenAPI/README、前端 scope 文案（5 种语言）、10 个 Go 测试。无数据库迁移。

### 0002 daemon 凭据

`0002-fix-plugins-daemon-credential-for-hook-only-tasks.patch` 修复真实 daemon 的插件工具鉴权：原实现仅在运行包含远程 MCP 连接时签发 daemon 凭据，只有 HTTP 插件工具的运行会遗漏凭据，工具调用因此返回 401。补丁在存在任一种工具时签发原有的工作区与 daemon 范围凭据；签名密钥仍只在服务端。真实智能体联调复现了该问题，新增回归覆盖凭据签发、范围、期限、缺少 daemon 身份时拒绝和无工具时不签发。

### 0003 快速创建的运行类型

`0003-fix-plugins-quick-create-kind-after-issue-linking.patch` 修复快速创建的类型变化：真实 CLI 创建 issue 后会把它关联到原运行，先前任务读取 API 此时优先返回 `kind=issue`，导致归档离开开始召回时使用的 run 空间，并遗漏成员的快速创建提示。现在关联前后均保留 `kind=quick_create` 与原始提示；普通 issue、私聊和创建 issue 的自动化仍遵循原有归属。新增真实 PostgreSQL 回归先复现失败，修复后通过。

### 0004 确认已发布的交付

`0004-feat-recover-confirmed-final-delivery.patch` 增加显式交付恢复：成员核验某次失败运行已经发布的最终评论后，可把其精确内容作为交付结果。仅接受错误包含 `Missing Authentication header` 的 issue 运行；评论必须属于该运行与智能体，且 SHA-256 与当前内容匹配。事务检查没有已存在的重试、重跑或活跃后续运行，恢复时不创建任务、评论或模型调用。原始失败原因保存在 `result.delivery_recovery`，重复提交同一凭据返回 `recovered: false`。这项操作需要人工确认评论确实是完整交付，不应在收到任意评论或任意 401 时自动执行。

#### 接口

`POST /api/tasks/{taskId}/recover-delivery` 使用现有成员登录与 `X-Workspace-ID`，拒绝 agent actor，仍检查工作区及私有智能体访问权限。请求体上限 4 KiB：

```json
{"comment_id":"<已核验的最终评论 UUID>","comment_sha256":"<评论原始 UTF-8 内容的 64 位小写 SHA-256>"}
```

响应为 `{"task_id":"…","status":"completed","recovered":true,"comment_id":"…"}`；再次提交相同凭据时 `recovered` 为 `false`。错误的内容摘要、来源、失败类型或已有后续运行返回 409；无效摘要返回 400；其他工作区任务返回 404，无私有智能体访问权返回 403。评论修改会使原摘要失效。恢复完成只广播原任务的完成事件，供插件按原 task ID 归档；它不保证评论语义正确，确认者须核验答案。

### 0005 同一 issue 上的自我 @

`0005-fix-comments-stop-an-agent-s-own-mention-from-re-que.patch` 修复同一 issue 上的“自己 @ 自己”循环：智能体回复交接时，如果开头照抄了交接评论里指向自己的 mention（`[@复核智能体](mention://agent/<自己>) 已复核……`），原实现会在这次运行结束后再派发它一次，它的下一条回复又会触发下一次，没有尽头。Multica 有意允许智能体 @ 自己，用来从一个 issue 通知它也负责的另一个 issue；原有的防循环 `hasPendingTaskForIssueAndAgent` 只能把 mention 合并进仍在排队的任务，挡不住一次接一次的串行运行。2026-10-08 的真实智能体回归中，接收方约 13 分钟多跑了 31 次，直到 daemon 停止（见本仓库 `reports/real-agent-2026-10-08-regression.md`）。现在，评论的作者 @ 自己、且评论由它在同一 issue 上的运行写出（服务端可信的 authoring task）时，这个 mention 记为 `blocked/self_trigger_suppressed`，不再派发；跨 issue 的自我通知、没有 authoring task 的评论保持原样，同一条评论里 @ 的其他智能体照常派发。两个 Go 测试覆盖这两种情况，未修复时第一个测试失败（作者被重新排队）。整包运行 handler 测试时，打补丁后 `TestListIssuesPropertyFilterAndSort` 会失败（2026-10-09 在 `43b0571` 上实测：不打补丁 2/2 通过，打补丁 3/3 失败；单独运行通过），推测是新增测试让测试工作区的 issue 超过 200 个；只影响测试，不影响运行。
