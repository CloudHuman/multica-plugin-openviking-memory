# 真实模型 real-agent 重跑（dcc8bf2）— 2026-10-01 UTC

本次在 `fix/review-hardening` 的 `dcc8bf2` 上，用真实 `OPENROUTER_API_KEY` 重跑 basic 和 quality 两个套件，并与[上一轮](real-agent-2026-10-01-openrouter.md)逐项对比。

环境与上一轮相同：补丁版 Multica（`43b0571` + `0001`–`0004`）官方 daemon、OpenCode 1.17.7、OpenViking 0.4.22。执行模型为 `openrouter/openai/gpt-5.4-mini`；OV 的抽取、向量、重排分别用 `z-ai/glm-5.3-flash`、`qwen/qwen3-embedding-8b`、`qwen/qwen3-reranker-8b`。两个套件都设置了 `REAL_AGENT_OBSERVE_PROVIDER=1`，没有改插件代码，也没有在本地改测试代码。

## 结论

- 两个套件一次跑通：basic 13/13 通过（上一轮 12/13），quality 15/15 通过（上一轮 9/11，且私聊召回未执行）。9 个真实任务全部 completed，过程中没有续跑或重驱。
- 上一轮的三项 FAIL 全部转为 PASS：
  - `cross-task-recall`：召回兜底生效，验证器也已修正。
  - `current-entity-update`：验证器修正后通过。实体卡仍把"每月预算"写成"发布预算"，见第 2 节。
  - `dm-distilled-peer-layout`：记忆策略更新后，私聊偏好被抽取到 peer 空间，新会话也召回成功。
- 401：本轮没有复现。OV 发出 381 次请求，OpenCode 发出 42 次，每次都带 `bearer` 且 token 非空，没有 `provider_auth_reason`。这次重排请求也在观测范围内。
- 新发现两点：
  - basic 的实体卡"进度"一节仍写有"在任务 RAM-1 下确认"。这违反了新策略中"实体卡不写 issue 编号"的规定，但现有检查没有覆盖这一点。
  - 召回中出现 4 次 `timedOut`，其中 2 次在 RAM-4"无答案"任务里。

## 1. basic

| 检查 | 上一轮 | 本轮 |
| --- | --- | --- |
| runtime | PASS | PASS |
| actual-tools | PASS | PASS |
| successful-memory-tools | PASS | PASS |
| automatic-extraction | PASS | PASS |
| archive-prompt-hygiene | PASS | PASS |
| active-memory-index | PASS | PASS |
| recall-bound-to-run | PASS | PASS |
| cross-task-recall | **FAIL** | PASS |
| no-answer | PASS | PASS |
| runtime-read-archive-hygiene | PASS | PASS |
| runtime-read-exercised | PASS | PASS |
| distilled-prompt-hygiene | PASS | PASS |
| memory-quality | PASS | PASS |

| 任务 | 状态 | 运行耗时（上一轮） |
| --- | --- | --- |
| RAM-1 海棠迁移方案确认 | completed | 28 s（31 s） |
| RAM-2 新任务查询海棠既有方案 | completed | 27 s（32 s） |
| RAM-3 平台说明读取归档隔离诊断 | completed | 15 s（16 s） |
| RAM-4 无答案问题 | completed | 45 s（27 s） |

套件 16:37:52 开始，16:41:09 结束。

**RAM-2 的召回**：本轮 RAM-2 只调用了 1 次召回（上一轮 2 次）。

- 智能体传入的原始 query 是 `issue 01a0f855-a558-7d31-a1a1-bfb0c5c25628 context or prior work`，仍是"UUID + 泛化措辞"的形态。
- 返回结果新增了 `query_rewritten_from`，值就是上面的原始 query；还新增了 `notes`："原 query 用当前运行的 issue 或任务标识指代本任务，标识本身不含业务含义；已在查询前补入该 issue 的业务目标，召回范围保持不变。"
- 实际执行的 query 是 issue 标题和正文，后接去掉 UUID 后的原措辞"issue context or prior work"。
- agent 范围命中 2 条，返回了 `海棠迁移方案确认-297b55.md`；task 和 shared 两个范围是 `not-provisioned`。
- 智能体的评论列出了 RocketMQ、3800 元、两周、10000 条四项，并引用了这次召回返回的 URI，`cross-task-recall` 通过。

## 2. quality

| 检查 | 上一轮 | 本轮 |
| --- | --- | --- |
| runtime | PASS | PASS |
| automatic-fact-fidelity | PASS | PASS |
| lasting-preference-retained | PASS | PASS |
| no-active-write-shortcut | PASS | PASS |
| current-entity-update | **FAIL** | PASS |
| historical-budget-retained | PASS | PASS |
| entity-category-stable | PASS | PASS |
| updated-uri-repromoted | PASS | PASS |
| real-B-current-shared-recall | PASS | PASS |
| real-B-task-delivery | PASS | PASS |
| dm-distilled-peer-layout | **FAIL** | PASS |
| real-DM-layout-recall | 未执行 | PASS |
| peer-audit-coverage | 未执行 | PASS |
| reusable-memory-hygiene | 未执行 | PASS |
| runtime-markers-filtered | 未执行 | PASS |

| 任务 | 状态 | 运行耗时 |
| --- | --- | --- |
| quality-seed | completed | 17 s |
| quality-budget-update | completed | 26 s |
| quality-shared-recall（B） | completed | 26 s |
| quality-dm-seed（私聊） | completed | 25 s |
| quality-dm-recall（私聊新会话） | completed | 22 s |

套件 16:41:24 开始，16:47:22 结束。shared 和 dm 两个范围的就绪检查都是第 1 次就成功。

**实体卡原文**。判定用卡在 seed 任务范围，URI 为 `viking://user/mcs-f71de3b73955/memories/entities/项目/苍鹭.md`，更新后的 Description 如下：

```
- 苍鹭项目发布使用 Apache Pulsar。
- 项目发布预算为 8100 元（2026-10-01 更新，明确以本次调整为准）。
- 项目采用双写方案，双写持续五天（截至 2026-10-01）。
- 该项目代码注释统一使用中文（截至 2026-10-01）。
```

- 这张卡没有 RAM-n 编号，没有 Relations 一节，也没有"被查询、被召回"之类的关系描述。卡里不再提 7600；历史值保留在 events 中，`historical-budget-retained` 通过。
- 晋升到 shared 范围的副本写的是"项目发布预算为 8100 元（2026-10-01 更新，以本次调整为准；原每月预算为 7600 元）"。
- 两张卡都把"每月预算"写成了"发布预算"，丢了"每月"这一周期限定词，这个问题与上一轮相同。B 在共享召回中仍答出了 8100、Pulsar、五天。
- 上一轮 B 的回答曾被抽成一张带"RAM-2"和"查询关系"的实体卡；本轮 B 的任务抽取为 0 条，没有生成这类卡。

**私聊种子任务**。`memory_diff` 为 adds 1、updates 0、deletes 0（上一轮全为 0）。新增的是 `viking://user/mcs-0c9bd105ce9f/peers/41d96e9e-…/memories/preferences/mcs-0c9bd105ce9f/蓝鹊周报排版格式（私聊专用）.md`，内容如下：

```
- 蓝鹊周报固定使用三个中文标题：风险、进展、下一步，且风险放第一位。
- 该排版约定仅适用于与此成员的私聊，不写入公共记忆。
```

`dm-distilled-peer-layout` 和 `real-DM-layout-recall` 都通过。

**残留问题**：

- basic 的实体卡 `entities/项目/海棠迁移.md`，"进度"一节写着"方案于 2026-10-01 在任务 RAM-1 下确认"和"该任务为隔离联调任务，无代码变更"。前一句带 issue 编号，与新策略不符；后一句是任务过程信息，不是业务事实。现有的 memory-quality 规则没有检查这两类内容，所以仍判 PASS。
- quality 的 events 文件中仍有"记忆召回为空不影响结论"这类检索结果描述，ChatLog 里也带着 RAM-1 标题。events 本身记录的就是事件，现有检查不覆盖这些内容。

## 3. 401 统计

### OpenViking

| endpoint | client | HTTP | `authorization_scheme` | `authorization_token_present` | `provider_auth_reason` | 次数 |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/v1/embeddings` | httpx | 200 | bearer | true | — | 223 |
| `/api/v1/chat/completions` | httpx | 200 | bearer | true | — | 43 |
| `/api/v1/chat/completions` | httpx | 传输错误 ReadError | — | 请求时为 true | — | 1 |
| `/api/v1/rerank` | requests | 200 | bearer | true | — | 112 |
| `/api/v1/rerank` | requests | 503 | bearer | true | — | 3 |

请求侧共 381 次（embeddings 223、chat 44、rerank 115），全部带 `bearer` 和非空 token。

- chat 的 ReadError 发生在 16:42:42，耗时 14.7 s 后断开；之后的抽取没有失败。20 次 `session_commit` 全部 completed，没有出现 `SessionCommit: Expecting value`，不需要重启 OV。
- 重排的 3 次 503 与 OV 日志中的 3 条 `Rerank failed: 503` 一一对应，都回退到纯向量检索。

### OpenCode

| 套件 | endpoint | 来源 | HTTP | `authorization_token_present` | `provider_auth_reason` | 次数 |
| --- | --- | --- | --- | --- | --- | --- |
| basic | `/api/v1/chat/completions` | http | 200 | true | — | 23 |
| quality | `/api/v1/chat/completions` | http | 200 | true | — | 19 |

OV 日志和两个插件日志中都没有 `401`、`Missing Authentication header`、`User not found.`、`No cookie auth credentials found`。

## 4. 延迟与 timedOut

| endpoint | n | p50 | p95 | 最大 |
| --- | --- | --- | --- | --- |
| embeddings | 223 | 5.4 s | 31.2 s | 53.0 s |
| chat | 43 | 9.7 s | 21.5 s | 22.1 s |
| rerank | 115 | 0.59 s | 1.27 s | 6.99 s |

OV 日志中有 154 条 `embedding slow call`。上一轮 embeddings 的 p50 是 677 ms，本轮升到 5.4 s，说明 OpenRouter embeddings 在这段时间整体偏慢。

9 次召回结果中，有 4 个范围出现 `timedOut: true`：

- RAM-4"无答案问题"两次召回中，agent 范围各超时 1 次。这时 `no-answer` 判 PASS，不能区分"确实没有证据"和"检索超时"；智能体的回答属于前者的表述。RAM-4 运行耗时也从 27 s 增加到 45 s。
- quality-budget-update 的一次召回中，task 和 shared 范围各超时 1 次。之后的更新抽取和共享召回不受影响。

## 5. 成本

用运行前后 `/api/v1/key` 的 `usage` 之差计算：0.51153918 − 0.24905166 = **0.2625 美元**。

| 部分 | token | 估算 |
| --- | --- | --- |
| 智能体（gpt-5.4-mini，9 个任务） | 输入 193,929、输出 6,051、缓存读 473,600 | ≈ 0.21 美元 |
| OV 抽取（glm-5.3-flash，20 次提交） | prompt 265,187、completion 17,075 | ≈ 0.048 美元 |
| 向量与重排 | — | < 0.005 美元 |

## 6. 环境与过程

- 容器在两轮之间重启过，服务进程停了，临时目录保留。这次直接复用已有构建，依次启动了 PostgreSQL、OV 和 Multica 服务端。
- 用 OV venv 重新生成了 `scripts/install-memory-policy.py` 模板，再用 `yaml.safe_load` 解析：9 个模板都含 "limits sharing, not remembering"。
- OV 的观测写入新文件，与上一轮分开统计。OV 数据目录沿用上一轮，但本轮两个套件都建了新的 Multica 工作区和 OV 账户，统计只取本轮新建的账户和会话。
- 报告和 JSON 不含任何凭据。本地随机凭据只保存在会话临时目录。

## 7. 需要用户决定的事项

1. 实体卡策略是否要覆盖"进度"类条目：basic 卡里仍有"在任务 RAM-1 下确认"。可以考虑在 memory-quality 规则里加入 RAM-n 和任务过程描述的检查。
2. "每月预算"连续两轮都被写成"发布预算"。是否在策略里要求保留金额的周期限定词，或者在 `hasCurrentBudget` 中检查"每月"。
3. RAM-4 有召回超时时，`no-answer` 仍判 PASS。是否在召回含 `timedOut` 时把该检查标为不确定，并要求智能体说明检索不完整。
4. 本轮 embeddings 的 p50 是 5.4 s，召回超时与慢调用时间吻合。是否调大召回超时，或者在报告里把超时单独列为环境因素。
