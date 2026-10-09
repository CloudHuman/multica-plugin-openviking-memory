# multica 补丁：任务读取 API 与运行上下文

`0001-feat-plugins-task-read-API-and-run-context-for-agent.patch` 是给 multica 服务端的补丁（基线 `e31da86`，multica main @ 2026-09-30）。它补上插件系统 v1 的一处缺口：插件能收到 `task.completed`，却读不到**这次运行里发生了什么**；智能体调用插件工具时，插件也不知道**是哪一次运行在调用**。

下方 stock 降级矩阵描述没有 `0001` 任务读取接口时的能力；真实 daemon 的 HTTP 插件工具仍需 `0002` 凭据修复。应用 `0001` 后才能归档运行转写、按运行绑定召回、归档私聊。

`0002-fix-plugins-daemon-credential-for-hook-only-tasks.patch` 修复真实 daemon 的插件工具鉴权：原实现仅在运行包含远程 MCP 连接时签发 daemon 凭据，只有 HTTP 插件工具的运行会遗漏凭据，工具调用因此返回 401。补丁在存在任一种工具时签发原有的工作区与 daemon 范围凭据；签名密钥仍只在服务端。真实智能体联调复现了该问题，新增回归覆盖凭据签发、范围、期限、缺少 daemon 身份时拒绝和无工具时不签发。

`0003-fix-plugins-quick-create-kind-after-issue-linking.patch` 修复快速创建的类型变化：真实 CLI 创建 issue 后会把它关联到原运行，先前任务读取 API 此时优先返回 `kind=issue`，导致归档离开开始召回时使用的 run 空间，并遗漏成员的快速创建提示。现在关联前后均保留 `kind=quick_create` 与原始提示；普通 issue、私聊和创建 issue 的自动化仍遵循原有归属。新增真实 PostgreSQL 回归先复现失败，修复后通过。

`0004-feat-recover-confirmed-final-delivery.patch` 增加显式交付恢复：成员核验某次失败运行已经发布的最终评论后，可把其精确内容作为交付结果。仅接受错误包含 `Missing Authentication header` 的 issue 运行；评论必须属于该运行与智能体，且 SHA-256 与当前内容匹配。事务检查没有已存在的重试、重跑或活跃后续运行，恢复时不创建任务、评论或模型调用。原始失败原因保存在 `result.delivery_recovery`，重复提交同一凭据返回 `recovered: false`。这项操作需要人工确认评论确实是完整交付，不应在收到任意评论或任意 401 时自动执行。

`0005-fix-comments-stop-an-agent-s-own-mention-from-re-que.patch` 修复同一 issue 上的“自己 @ 自己”循环：智能体回复交接时，如果开头照抄了交接评论里指向自己的 mention（`[@复核智能体](mention://agent/<自己>) 已复核……`），原实现会在这次运行结束后再派发它一次，它的下一条回复又会触发下一次，没有尽头。Multica 有意允许智能体 @ 自己，用来从一个 issue 通知它也负责的另一个 issue；原有的防循环 `hasPendingTaskForIssueAndAgent` 只能把 mention 合并进仍在排队的任务，挡不住一次接一次的串行运行。2026-10-08 的真实智能体回归中，接收方约 13 分钟多跑了 31 次，直到 daemon 停止（见本仓库 `reports/real-agent-2026-10-08-regression.md`）。现在，评论的作者 @ 自己、且评论由它在同一 issue 上的运行写出（服务端可信的 authoring task）时，这个 mention 记为 `blocked/self_trigger_suppressed`，不再派发；跨 issue 的自我通知、没有 authoring task 的评论保持原样，同一条评论里 @ 的其他智能体照常派发。两个 Go 测试覆盖这两种情况，未修复时第一个测试失败（作者被重新排队）。

## 补丁内容

| 变更 | 说明 |
| --- | --- |
| `GET /v1/tasks/{task_id}` | 运行本身（kind：issue / chat / autopilot / quick_create / other，关联的 issue / 私聊 / 自动化，attempt，状态）+ 触发它的输入（私聊消息、触发评论、快速创建提示、委派交接），每类输入各自受读权限约束 |
| `GET /v1/tasks/{task_id}/messages` | 运行转写，不透明游标分页（`cursor` / `next_cursor`，默认 50、上限 200 条），超长字段按 32 KiB 在字符边界截断 |
| 新 scope `chats:read` | 私聊运行的输入与转写是私人对话，`tasks:read` 单独不可读；需安装时额外授权 |
| 智能体工具钩子携带运行上下文 | 钩子请求体带 `task_id` / `issue_id`，取自被认领的任务行（不是模型给的）；该次回调凭据的**任务读取**被收窄到这一次运行，issue 读取范围不变 |
| 任务事件收窄凭据 | `task.*` 事件的回调凭据只能读它所报告的那一次运行 |

另含：两条 sqlc 查询（`ListTaskMessagesPage`、`ListUserChatMessagesByTask`）及生成代码、OpenAPI/README、前端 scope 文案（5 种语言）、10 个 Go 测试。无数据库迁移。

## 应用与验证

```bash
cd <multica 仓库>
git checkout 43b0571            # 本轮真实智能体验证的服务端基线
git am <本仓库>/upstream/multica/0001-*.patch
git am <本仓库>/upstream/multica/0002-*.patch
git am <本仓库>/upstream/multica/0003-*.patch
git am <本仓库>/upstream/multica/0004-*.patch
git am <本仓库>/upstream/multica/0005-*.patch
cd server && go build ./... && go vet ./internal/handler/ ./internal/service/

# 补丁自带测试（需要已迁移的测试库）
DATABASE_URL=postgres://…/multica_test go test ./internal/handler/ -run 'PluginTask|PluginChatRun|AgentHook' -count=1
DATABASE_URL=postgres://…/multica_test go test ./internal/service/ -run TestTaskIDFromPayloadOnlyReadsTheRunItReportsOn -count=1
DATABASE_URL=postgres://…/multica_test go test ./internal/handler/ -run 'TestRemoteMCPDaemonTokenForClaim|TestPluginHookOnlyClaimHasDaemonCredential' -count=1
DATABASE_URL=postgres://…/multica_test go test ./internal/handler/ -run TestPluginTaskQuickCreateKeepsOriginAfterCreatingIssue -count=1
DATABASE_URL=postgres://…/multica_test go test -race ./internal/handler/ -run TestRecoverTaskDelivery -count=1
DATABASE_URL=postgres://…/multica_test go test ./internal/handler/ -run AgentSelfMention -count=1
```

## 确认已发布的交付

`POST /api/tasks/{taskId}/recover-delivery` 使用现有成员登录与 `X-Workspace-ID`，拒绝 agent actor，仍检查工作区及私有智能体访问权限。请求体上限 4 KiB：

```json
{"comment_id":"<已核验的最终评论 UUID>","comment_sha256":"<评论原始 UTF-8 内容的 64 位小写 SHA-256>"}
```

响应为 `{"task_id":"…","status":"completed","recovered":true,"comment_id":"…"}`；再次提交相同凭据时 `recovered` 为 `false`。错误的内容摘要、来源、失败类型或已有后续运行返回 409；无效摘要返回 400；其他工作区任务返回 404，无私有智能体访问权返回 403。评论修改会使原摘要失效。恢复完成只广播原任务的完成事件，供插件按原 task ID 归档；它不保证评论语义正确，确认者须核验答案。

2026-09-30 在 `e31da86` 上验证：干净应用，`go build` / `go vet` 通过，10 个补丁测试全部通过；再用真实 multica（补丁版与 stock 版各一轮）跑 `e2e/real-stack/`，均 12/12（见 `reports/e2e-2026-09-30.md`）。

打补丁后，插件包用 `bash scripts/package.sh --with-chats-read …` 构建，安装时授予 `chats:read`，私聊运行才会被归档。stock multica 会拒绝带 `chats:read` 的清单，所以默认包不带它。

## 没有补丁时（stock multica）

| 能力 | 补丁版 | stock 版 |
| --- | --- | --- |
| issue 运行归档 | 转写 + 触发输入完整归档到任务协作空间 | 读不到转写：运行事件以 200 跳过；运行的**收尾评论**作为智能体陈述归档 |
| 私聊 / 自动化 / 快速创建 / 委派运行 | 按 kind 归档到配对 / 自动化 / 运行 / 委派通道空间 | 以 200 跳过（不再触发 multica 熔断）；私聊可改走配套 API `/internal/events` |
| `memory-recall` | 绑定到调用它的运行，模型给出的其他 `issue_id` 被忽略 | 不知道调用方是哪次运行：检索本智能体公共 + 共享，外加模型指定的 issue（multica 本身也允许智能体读工作区内任意 issue） |
| 评论、`memory-remember`、`ov-*` 门面、租户隔离、抽取自愈 | ✓ | ✓ |

## 维护方式

这些补丁由本仓库维护，不提交到 multica-ai/multica。部署时按上面的顺序应用到所用的 multica；升级 multica 后重新应用，并跑一遍补丁自带的测试。补丁按 multica 的公开 API 约定编写（problem+json 错误、不透明游标、`DefaultPageSize` / `MaxPageSize`、scope 目录），冲突时以这些约定为准调整。
