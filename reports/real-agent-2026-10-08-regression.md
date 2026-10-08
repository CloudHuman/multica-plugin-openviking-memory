# 真实模型回归：basic 与 matrix — 2026-10-08 UTC

basic 与 matrix 两个套件 10-01 之后都没有重跑。这期间插件改过几处，都会经过 matrix 覆盖的各个入口：

- 归档时用 issue 标题代替编号；
- 归档前按分句去掉成员写的执行指令（默认开启）；
- 清理后晋升；
- 工作区规则 `memory_rules`；
- 召回结果的字段顺序（本轮发现问题后修改，见 4.1）；
- 归档时省略工具输出里智能体自己的指令（本轮发现问题后修改，见 4.8）。

环境与本日其他报告相同：

- **链路**：补丁版 Multica（CLI `v0.6.0-11-g959fbae`）的官方 daemon、OpenCode 1.17.7、OpenViking 0.4.22；OV 配置为 `deploy/ov.openrouter.conf.example`。
- **模型**：执行模型 `openrouter/openai/gpt-5.4-mini`；抽取 `z-ai/glm-5.3-flash`；向量 `qwen/qwen3-embedding-8b`；重排 `qwen/qwen3-reranker-8b`。
- **设置**：原生抽取（`REAL_AGENT_MEMORY_POLICY=native`），归档前去掉执行指令（默认值），`REAL_AGENT_OBSERVE_PROVIDER=1`。

## 结论

1. **basic 13/13 通过**：4.0 分钟，$0.09。
2. **matrix 第 4 次（全新完整一轮）跑完全程，27/30**：
   - 这一轮带上了 Multica 补丁 0005 和下面全部测试脚本修复。第二次交接在同一工作区上用 `history` 阶段单独重测过一次，计入结果。
   - 并发隔离、共享晋升、B 从共享记忆召回都通过，也没有出现自我 @ 循环。
   - 剩下 3 项失败，都不是插件回归（见第 7 节）：
     - **快速创建**：A 先执行建 issue 的命令，后写描述文件，命令失败；快速创建规则不允许重试，所以没建出 issue。插件这边召回绑定到快速创建运行、归档进 run 空间，都正确。
     - **归档卫生**：A 用 `multica agent list --output json` 查自己，输出里带着智能体自己的指令（含测试标记），进了这次运行的归档。插件已修复（`ff82bbe`）；抽取出的记忆里没有这段内容。
     - **记忆质量**：两张任务空间的实体卡被原生抽取写进了运行记录，例如“本次召回未返回可引用的既有来源 URI”。这是已知的原生抽取弱点；召回摘录和共享晋升会去掉这类句子，共享空间审计干净。
3. **前 3 次都没跑完**。三次停下的原因都在测试脚本、Multica 平台和模型行为上：
   - 第 3 次 22/23 项通过，唯一失败是第二次交接：A 没有把问题转给 B。
   - 第一次交接后，B 陷入“自己 @ 自己”的循环，套件在并发检查前等待超时中断。
   - 第 3 次的收尾审计离线补跑（只读 OV，不调用模型），3/3 通过。
4. **测试脚本问题 7 个，都已修复**（见第 4 节）：
   - 工具输出只保存 8 KB 预览，检查误判召回缺失；
   - B 的回复又 @ 了自己，检查取错了接收方的任务；
   - 协作检查有漏洞：B 直接读评论区，测不到任务记忆；
   - 第二次交接时 A 没有转交：一次自己作答，一次漏了 mention；
   - 交接描述里，评论后面还跟着给 A 的指令，A 把它们一起抄进了评论，B 照着只回了一句；
   - 自我 @ 循环没有保护；
   - 收尾审计引用了未传入的参数，10-01 以来每次跑到最后都会抛错。
5. **自我 @ 循环（平台问题）**：
   - **起因**：Multica 有意允许智能体 @ 自己（用来通知另一个 issue），防循环只合并“同时排队”的任务。B 回复 A 的交接评论时，开头照抄了 mention `[@复核智能体](mention://agent/<B>)`，于是每次回复都会让 B 在同一 issue 上再跑一次。
   - **规模**：约 13 分钟内多跑了 31 次，约占这一轮花费的四分之三（约 $1.9），还多做了约 60 次抽取。
   - **对记忆的影响**：委派通道保持干净，只有 1 次真实交接进入 A→B 通道；但这个 issue 的任务记忆写进了循环内容，详见第 5 节。
   - **处理**：按决定写了 Multica 补丁 0005，第 4 次运行时已打上（见第 6 节）。
6. **请求**：OpenCode 四次 matrix（含重测）、一次 basic 共 464 次模型请求，全部返回 200，没有 401。
7. **花费**：basic $0.09；matrix 前三次 $0.37 + $0.39 + $2.59，合计 $3.43。第 4 次（含第二次交接重测）还在入账，见第 1 节。

## 1. 运行记录

| 轮次 | 代码 | 结果 | 用时 | 花费 | 停在哪里 |
| --- | --- | --- | --- | --- | --- |
| basic | `3db032e` | 13/13 | 4.0 分钟 | $0.0913 | 跑完 |
| matrix 第 1 次 | `3db032e` | 6/12 | 8.2 分钟 | $0.3651 | 发现误判后手动停止 |
| matrix 第 2 次 | `b05b662` | 11/12 | 16.9 分钟 | $0.3867 | 第二次交接没派发到 B，等满 10 分钟后中断 |
| matrix 第 3 次 | `87a4dc2` | 22/23 | 19.7 分钟 | $2.5865 | 自我 @ 循环，并发检查前等待超时 |
| matrix 第 4 次 | `93b9fd9`，Multica 加补丁 0005 | 26/30 | 17.9 分钟 | 待入账 | 跑完 |
| 第 4 次的第二次交接重测 | `ff82bbe` | 1/1 | 约 2 分钟 | 待入账 | 跑完 |

花费是 OpenRouter 账户用量在每轮前后的差值，包含 OV 的抽取、向量和重排；每轮结束后多等 60 秒，等最后的抽取调用落账。第 1 次的值包含停下后补完的抽取。第 3 次结束 60 秒后读到的是 $1.98，之后约 15 分钟里又入账 $0.61，然后不再变化。这段时间栈里没有任何模型调用：抽取代理的最后一次调用在 15:24:30，OV 的向量与重排在 15:24:33，daemon 已停止。当天的总用量也和各轮读数完全对得上，所以这 $0.61 是第 3 次延迟入账的费用，多半来自被取消的流式请求。之后到 16:01 又多了 $0.11，期间同样没有模型调用（Multica 服务端本身不调用 OpenRouter），多半也属于第 3 次。

第 4 次入账更慢：开始和结束时读到的用量相同，结束后约 7 分钟只入账了 $0.013。可是这一轮 OpenCode 的 122 次请求、抽取代理的 91 次调用全部返回 200。按 token 看，这一轮 25 次运行共有非缓存输入 52 万、缓存读取 129 万、输出 1.6 万，和第 3 次中循环以外的 21 次运行（44 万、127 万、1.4 万）相当。运行脚本原本在用量连续两次读数相同时就记下结束值，入账这样慢时会提前停下；第 4 次的实际花费等入账稳定后再补。

## 2. basic 逐项

| 检查 | 结果 |
| --- | --- |
| runtime | PASS |
| actual-tools | PASS |
| successful-memory-tools | PASS |
| automatic-extraction | PASS |
| archive-prompt-hygiene | PASS |
| active-memory-index | PASS |
| recall-bound-to-run | PASS |
| cross-task-recall | PASS |
| no-answer | PASS |
| runtime-read-archive-hygiene | PASS |
| runtime-read-exercised | PASS |
| distilled-prompt-hygiene | PASS |
| memory-quality | PASS |

记忆审计：智能体公共空间 1 个文件、任务空间 1 个文件，质量问题 0，实体卡观察 0。

## 2b. matrix 第 3 次逐项

| 入口或边界 | 检查 | 结果 |
| --- | --- | --- |
| 运行时 | runtime | PASS |
| 主动记忆与各自公共空间 | active-write-agent-A、agent-public-isolation | PASS |
| 原生读取门面 | actual-facade-cross-agent-denial | PASS |
| 同一 issue 改派 | archive-collaboration-seed、multi-agent-collaboration | PASS（A 的确认评论已删除，B 只能靠任务记忆） |
| 成员评论、重跑、唤醒 | member-comment-follow-up、manual-rerun-recalls-issue、wakeup-recalls-issue | PASS |
| @mention 委派 | real-delegation-linked、archive-delegation-receiver、real-delegation-archive | PASS |
| 第二次交接 | delegation-cross-task-recall | **FAIL**（A 写了“已转交复核智能体”，但漏了 mention） |
| 私聊 | archive-chat-seed、new-chat-pair-recall、chat-pair-isolation | PASS |
| 快速创建 | quick-create-actual-issue、archive-quick-create | PASS |
| 自动化 | archive-autopilot-seed、autopilot-cross-run-recall、autopilot-webhook-recall、autopilot-schedule-actual-run、autopilot-create-issue-memory | PASS |
| 并发、追加、共享晋升 | actual-parallel-runs-isolated、shared-promotion-excludes-private-chat、multi-agent-shared-recall | 未跑到 |
| 收尾审计（离线补跑） | matrix-archive-prompt-hygiene、matrix-prompt-hygiene、matrix-memory-quality | PASS：21 份归档、22 个记忆文件；质量问题 0；实体卡观察 2（运行记录） |

## 2c. matrix 第 4 次逐项

| 入口或边界 | 检查 | 结果 |
| --- | --- | --- |
| 运行时 | runtime | PASS |
| 主动记忆与各自公共空间 | active-write-agent-A、agent-public-isolation | PASS |
| 原生读取门面 | actual-facade-cross-agent-denial | PASS |
| 同一 issue 改派 | archive-collaboration-seed、multi-agent-collaboration | PASS |
| 成员评论、重跑、唤醒 | member-comment-follow-up、manual-rerun-recalls-issue、wakeup-recalls-issue | PASS |
| @mention 委派 | real-delegation-linked、archive-delegation-receiver、real-delegation-archive | PASS |
| 第二次交接 | delegation-cross-task-recall | 第 4 次 FAIL（A 把给自己的指令也抄进评论，B 照着只回了一句、没有召回）；重测 PASS |
| 私聊 | archive-chat-seed、new-chat-pair-recall、chat-pair-isolation | PASS |
| 快速创建 | quick-create-actual-issue、archive-quick-create | **FAIL**（没建出 issue）、PASS |
| 自动化 | archive-autopilot-seed、autopilot-cross-run-recall、autopilot-webhook-recall、autopilot-schedule-actual-run、autopilot-create-issue-memory | PASS |
| 并发 | actual-parallel-runs-isolated | PASS；运行中追加输入仍返回 412（已知不支持，不计入） |
| 共享晋升 | shared-promotion-excludes-private-chat、multi-agent-shared-recall、archive-shared-recall | PASS |
| 收尾审计 | matrix-archive-prompt-hygiene、matrix-prompt-hygiene、matrix-memory-quality | **FAIL**（快速创建归档带测试标记）、PASS（28 个记忆文件）、**FAIL**（2 张实体卡带运行记录） |

## 3. 与 10-01 的对比

10-01 的 matrix 经多次修复、续跑后 30 项通过。这次第 3、4 次的相同入口里，除了第二次交接（第 4 次重测通过）和第 4 次的快速创建（模型执行失误），都一次通过，包括：

- 同一 issue 改派后，B 从任务记忆召回；
- 成员评论、重跑、唤醒都绑定原 issue；
- 委派进入 A→B 通道；
- 新私聊会话召回配对记忆，另一智能体不搜索该私聊；
- 快速创建落在 run 空间；
- 自动化的四种触发核对了范围；
- 并发运行互不串任务，共享晋升不带私聊，B 从共享记忆找回事实（第 4 次）。

10-01 之后加的归档改动没有破坏这些入口：

- 归档用标题代替编号；
- 归档前去掉执行指令；
- 清理后晋升。

## 4. 发现与修复

### 4.1 Multica 只保存工具输出的前 8 KB（第 1 次，`b05b662`）

Multica daemon 在任务记录里只保存每次工具输出的前 8,192 字节预览（`output_truncated: true`），智能体本身收到的是完整输出。召回到几条较长的事件记忆时，结果超过 8 KB，检查脚本解析不了 JSON，就把这次召回当成没有发生。第 1 次因此有 4 项误判：协作、成员评论、重跑、唤醒。智能体其实召回并引用了正确的记忆。

修复：

- `memory-recall` 的结果先列运行绑定和查询过的范围，再列条目，预览里总能保留这两部分；
- 检查脚本共用一个读取函数，从截断的预览里恢复状态、运行绑定、查询和完整到达的条目，不补造缺失的部分。

### 4.2 B 的回复又 @ 了自己（第 1 次，`b05b662`）

B 在回复里写了指向自己的 mention，平台在同一 issue 上又派发了一次 B。检查脚本取到的是这第二次任务：它没有调用召回，也不是委派触发的，委派关联和委派归档两项因此失败。现在固定取接收方在该 issue 上的第一次任务，也就是 A 的交接触发的那次。4.5 是这个问题的后续。

### 4.3 协作检查的漏洞（第 2 次，`87a4dc2`）

issue 改派给 B 后，B 先读评论区，直接照抄了 A 的确认评论，引用的是评论 ID，没有调用 memory-recall；检查因此失败，而且它测的已经不是任务记忆了。现在改派前，先删除 A 在该 issue 下的确认评论；这时 A 的记忆已经抽取完、可以检索。工作区所有者可以删智能体的评论（实测返回 204）。第 3 次中，B 调用 memory-recall，找回 Pulsar、7600 元、五天，并引用了任务记忆的 URI。

### 4.4 第二次交接：A 没有转交（第 2、3 次，`87a4dc2`、`166b4b2`）

第二次交接要 A 把问题转给 B，不提供重试上限的数字，看 B 能否从委派通道找回。

- **第 2 次**：A 召回后没找到雨燕的数字，就自己回复“未找到”，没有 @B。脚本等满 10 分钟，然后整轮中断，后半段都没跑。
- **第 3 次**：交接指令已写明“只负责转交、不要自己回答”。这次 A 的召回超时，它写了一条“已转交复核智能体……请按要求继续查询”，但漏掉了 mention，B 仍没有被派发。

修复：

- 现在直接给 A 一条要原样发布的评论，mention 放在开头；
- A 结束两分钟后仍没有派发出 B 的任务，就记一项失败、继续往下跑；
- 新增 `REAL_AGENT_MATRIX_PHASE=history`，在原工作区只重跑这一步。

第一次交接的指令本来就要求“评论必须包含完整 mention”，四次都成功派发了 B。

### 4.5 自我 @ 循环（第 3 次，`6d2f869`）

经过：

- B 回复 A 的交接评论时，开头照抄了 A 写的 mention。
- Multica 的派发逻辑（`resolveMentionedAgentCommentTriggers`）有意允许智能体 @ 自己，用来从子 issue 通知父 issue。防循环只靠“同一 issue、同一智能体已有待执行任务时合并”。
- 于是 B 每跑完一次，它的回复就让 B 在同一 issue 上再排一次：从 15:10:59 到 15:24:00 约 13 分钟，共多跑 31 次，直到套件结束、daemon 停止才中断。
- 这些运行在后台进行，同期的私聊、快速创建、自动化检查都正常完成。但到并发检查前，A、B 一直不空闲，等待超时，套件中断。

| | 循环中的 31 次运行 | 本轮其余 21 次运行 |
| --- | --- | --- |
| 非缓存输入 token | 2,167,377 | 440,084 |
| 缓存读取 token | 4,222,464 | 1,268,224 |
| 输出 token | 11,845 | 13,840 |

循环占本轮非缓存输入的 83%。每次运行的上下文都在变长：评论区越来越长，召回结果也越来越多。这个 issue 的任务空间还做了约 60 次抽取（运行归档与评论归档各约 30 次）。按 token 和抽取次数估算，本轮 $2.59 中约四分之三（约 $1.9）花在循环上。

修复（测试脚本）：

- 找到接收方的第一次任务后，开始监视该 issue；接收方之后在这里的任务，一出现就取消；
- 取消的任务记入报告的 `selfMentionReruns` 和一条限制说明；
- matrix 和 history 阶段都启用这个保护。

平台和插件层面的处理还需要决定，见第 6 节。

### 4.6 收尾审计抛错（离线补跑时发现，`c0ecbdd`）

`8bd8b13`（10-01）给记忆审计加了“本工作区的 issue 编号”这一项。`auditMatrix` 往下传了 `issuePrefix`，自己却没有接收这个参数，所以 matrix 和共享恢复阶段跑到最后一步都会抛 `ReferenceError`。10-01 之后没有一次 matrix 跑到这里，所以一直没有暴露。现已修复，并补了一条离线测试。

### 4.7 第二次交接的描述（第 4 次，`fd65453`）

第 4 次里 A 照描述原样发了评论，B 也被派发了；但描述里评论后面还跟着给 A 的几句话：“本次没有提供上限数字。不要猜测数字、主动记忆或修改代码。交接后提交简短最终回复……”。A 把它们一起抄进了评论，B 读到后照做：只回了一句“已收到……不会猜测”，一次召回都没调用。现在 A 的指令全部放在前面，要原样发布的评论是描述的最后一段。同一工作区上重测时，A 只发了那一句；B 调用两次召回，引用了 A→B 委派通道里的记忆（`peers/<A>/…/雨燕项目重试上限复核委派.md`），答出 7 次。检查失败时，说明也会写出 B 具体缺了哪一步（`9d05938`）。

### 4.8 归档带进智能体自己的指令（第 4 次，插件修复 `ff82bbe`）

快速创建时，A 为了确认负责人，执行了 `multica agent list --output json`。输出的智能体记录里带着 `instructions`，也就是智能体自己的系统指令，测试放在里面的平台标记随之进了这次运行的归档。插件原本只去掉以运行时横幅开头的平台说明，智能体记录没有这个标题。现在归档工具结果时，`instructions` 字段的值换成“[智能体指令已省略]”，记录的其余字段保留；被长度上限截断的值，从开头替换到截断处。这次抽取出的 28 个记忆文件里都没有这段内容，所以影响只在归档里。

## 5. 循环写进了什么记忆

委派通道 `delegation:…:A:B` 只有 1 次归档：插件只把发送方的交接评论当作委派。B 自己 @ 自己没有被算成委派，这是对的。但循环中的运行和评论都按正常规则进了这个 issue 的任务空间，OV 把约 60 次抽取合并成了 7 个文件：

- **实体卡 `雨燕项目.md`**：
  - 当前事实写成“项目重试上限为 7 次（2026-10-08 由复核智能体确认找到可追溯来源，可据此引用）”，可是这个“来源”就是这张卡自己和循环中的事件，属于循环引用。
  - 另一行记着“复核智能体多次复核（含 15:19-15:24 期间……的多次触发评论及回复）均确认结论不变”。
- **6 个事件**：记录各次复核的经过，例如“召回仍未拿到可追溯的更早记忆”“出现超时提示”。

审计结果：

- 实体卡的运行记录被实体卡审计标出（`entity-run-bookkeeping`，只是观察项，不算失败）。
- 质量过滤没有拦下“由复核智能体确认找到可追溯来源，可据此引用”：它不属于已知的执行指令或检索结论句式。
- 事件按设计保留检索经过，召回摘录时会去掉。

这个 issue 没有参与共享晋升（本轮没跑到）。如果晋升，这张卡会作为有效事实进入共享空间：7 次本身是对的，但出处说明是循环出来的。

## 6. 决定与处理

1. **自我 @ 循环：在 Multica 修**。补丁 [`upstream/multica/0005-*.patch`](../upstream/multica/README.md)：评论作者 @ 自己、且评论由它在同一 issue 上的运行写出时，这个 mention 记为 `blocked/self_trigger_suppressed`，不再派发；跨 issue 的自我通知、没有运行上下文的评论、同一评论里 @ 的其他智能体都照常。两个 Go 测试覆盖这两种情况，不修复时第一个失败；handler 包其余测试通过，只有 `TestListIssuesPropertyFilterAndSort` 例外，它在不打补丁时同样失败、单独跑则通过。第 4 次运行用的就是打了补丁的服务端，这一轮 B 两次回复都没有 @ 自己，补丁没被触发。测试脚本的保护保留，作为没打补丁时的兜底。
2. **matrix：全新完整跑一轮**，即第 4 次，见第 7 节。

## 7. 第 4 次：完整一轮

逐项结果见 2c。和第 3 次相比：

- 第 3 次没跑到的步骤这次都通过了：
  - **并发**：A、B 的运行时间有重叠，召回范围和业务标记都没有串到另一个任务。
  - **共享晋升**：只取智能体公共空间和任务空间，私聊不参与。
  - **B 从共享记忆召回**：找回 NATS 和 2450 元，并引用了共享空间的 URI。
- 两次交接都没有出现重复运行，`selfMentionReruns` 为空。
- 失败的 3 项：
  - **快速创建**：模型执行失误，A 先执行命令、后写文件，不处理。
  - **归档卫生**：插件已修，见 4.8。
  - **记忆质量**：原生抽取把运行记录写进了两张“青岚仓库”实体卡：
    - 种子任务那张写了“该约定由任务要求沉淀为公共记忆；本次召回未返回可引用的既有来源 URI”；
    - 共享召回那次的任务空间里那张写了“智能体已在评论中回复并引用来源 URI”。

    审计按 10-08 加严后的规则把它们判为执行指令。这类句子在召回摘录和共享晋升时会被去掉，共享空间的审计是干净的。10-08 的 config 轮里，工作区规则的抽取没有写出这类句子，这是继续推荐工作区规则的理由之一。
