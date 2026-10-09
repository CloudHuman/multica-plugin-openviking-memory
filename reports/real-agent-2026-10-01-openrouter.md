# 真实模型 real-agent 实测与 OpenRouter 401 复核 — 2026-10-01 UTC

> **后续变更**：本轮 OV 配置沿用当时的 `deploy/ov.openrouter.conf.example`，其中 `memory.custom_templates_dir` 指向由 `deploy/memory-policy.json` 生成的抽取模板。实例级模板随后已移除，默认改用 OV 原生模板；同类规则现在只作为测试选项写入测试账户的账号级模板（`REAL_AGENT_MEMORY_POLICY=account`），示例也不再使用测试值（见 README 变更记录）。因此本文的抽取与蒸馏质量结果不代表原生抽取或当前账号级规则下的表现。401 复核的结论不受影响。

使用真实 `OPENROUTER_API_KEY` 执行。链路为：补丁版 Multica（`43b0571` + `0001`–`0004`）官方 daemon、OpenCode 1.17.7、OpenViking 0.4.22。执行模型为 `openrouter/openai/gpt-5.4-mini`；OpenViking 的抽取、向量和重排沿用 `deploy/ov.openrouter.conf.example`，即 `z-ai/glm-5.3-flash`、`qwen/qwen3-embedding-8b`、`qwen/qwen3-reranker-8b`。

结论：本环境在真实密钥下没有复现 401。本轮共向 OpenRouter 发出 688 次带认证的请求，结果如下：

- 受控实验 340 次，全部 200。
- OpenViking 抽取与向量 303 次，全部 200。
- OpenCode 主循环 38 次，全部 200。
- 重排 5 次 503，不涉及认证。
- `/api/v1/key` 请求 2 次，均返回 200（第 2 次只用于读取当日用量）。

有观测字段的 341 次模型请求，`authorization_scheme=bearer`、`authorization_token_present=true` 都是 100%。插件诊断里没有出现 `provider_auth_reason`。所以，在密钥正确注入的进程中，链路不会产生空 token。这与[401 归因复核](auth-401-diagnosis-2026-10-01.md)的推断一致：此前的 `Missing Authentication header`，更可能是出错时段进程拿到的 `OPENROUTER_API_KEY` 为空。本轮无法重现那个时段的注入状态，因此不能就此证明原问题已消失。

basic 套件 12/13 通过，quality 套件 9/11 通过。3 项 FAIL 照实记录在下文，没有改写成通过：

- basic 的 `cross-task-recall`：检查器假阴性。
- quality 的 `current-entity-update`：检查器的正则过窄；抽取内容本身正确，但丢了"每月"。
- quality 的 `dm-distilled-peer-layout`：OpenViking 抽取没有产出私聊偏好，属于真实质量问题。

8 个真实任务全部 `completed`。机器记录见[同名 JSON](real-agent-2026-10-01-openrouter.json)。

## 1. 密钥与受控实验

| 检查 | 结果 |
| --- | --- |
| `[ -n "$OPENROUTER_API_KEY" ]` | PASS，非空，长度 73 |
| `GET /api/v1/key` | PASS，HTTP 200 |
| Python openai 2.54.0（OV venv，经 `HTTPS_PROXY`）：`qwen/qwen3-embedding-8b` embeddings 200 次，顺序和 8 路并发各 100 次 | PASS，200/200 返回 200 |
| 同上：`z-ai/glm-5.3-flash` chat 40 次，`max_tokens=1`，流式和非流式各 20 次，顺序和 8 路并发各 20 次 | PASS，40/40 返回 200 |
| Node 22.22.0 fetch（`NODE_USE_ENV_PROXY=1`）：embeddings 50 次、chat 50 次，顺序和 8 路并发各 50 次 | PASS，100/100 返回 200 |

受控实验没有出现任何 401、其他非 200 状态或传输错误。合计约 2,245 个 prompt token、70 个 completion token，成本低于 0.001 美元。

## 2. real-agent basic 套件

| 检查 | 结果 |
| --- | --- |
| runtime（官方 daemon 注册 OpenCode 1.17.7） | PASS |
| actual-tools（实际调用了 recall、remember 等工具） | PASS |
| successful-memory-tools | PASS |
| automatic-extraction | PASS |
| archive-prompt-hygiene | PASS |
| active-memory-index | PASS |
| recall-bound-to-run | PASS |
| cross-task-recall | **FAIL**（检查器假阴性，见下文） |
| no-answer | PASS |
| runtime-read-archive-hygiene | PASS |
| runtime-read-exercised | PASS |
| distilled-prompt-hygiene | PASS |
| memory-quality | PASS |

| 任务 | 状态 | 运行耗时 | 输入 / 输出 / 缓存读 token |
| --- | --- | --- | --- |
| RAM-1 海棠迁移方案确认 | completed | 31 s | 24,961 / 990 / 103,424 |
| RAM-2 新任务查询海棠既有方案 | completed | 32 s | 21,975 / 1,003 / 55,808 |
| RAM-3 平台说明读取归档隔离诊断 | completed | 16 s | 23,036 / 518 / 56,832 |
| RAM-4 无答案问题 | completed | 27 s | 19,957 / 804 / 71,168 |

运行耗时取自 `agent_task_queue.started_at` 到 `completed_at`，排队均不足 1 秒。整个套件 15:49:50 开始，15:53:23 结束。

`cross-task-recall` 失败的原因：RAM-2 的智能体先用任务 UUID 调了一次 `memory-recall`，结果为空；随后按工具提示改用"海棠迁移 项目 消息队列 预算 双写周期 死信告警 约定"再次召回，命中了 `viking://…/memories/cases/2026-10-01/海棠迁移方案确认-b9e3ac.md`（score 0.996）。最终评论列出了 RocketMQ、3800 元、两周、10000 条四项，并引用了该 URI。检查代码 `e2e/real-agent/run.mjs:190` 用 `.find` 只取第一个 `status=ok` 的召回，那次结果为空，所以 URI 比对失败。智能体的行为符合 skill 约定，这是验证器问题。改法写在第 7 节，等用户决定。

## 3. real-agent quality 套件

| 检查 | 结果 |
| --- | --- |
| runtime | PASS |
| automatic-fact-fidelity | PASS |
| lasting-preference-retained | PASS |
| no-active-write-shortcut | PASS |
| current-entity-update | **FAIL**（见下文） |
| historical-budget-retained | PASS |
| entity-category-stable | PASS |
| updated-uri-repromoted | PASS |
| real-B-current-shared-recall | PASS：B 从共享记忆召回 Pulsar、8100 元、5 天并引用 URI |
| real-B-task-delivery | PASS |
| dm-distilled-peer-layout | **FAIL**（见下文） |
| 私聊新会话召回 | 未执行：readiness 三次失败后套件中止 |

| 任务 | 状态 | 运行耗时 |
| --- | --- | --- |
| quality-seed（A，苍鹭初始约定） | completed | 18 s |
| quality-budget-update（成员评论把预算改为 8100） | completed | 17 s |
| quality-shared-recall（B，新 issue） | completed | 35 s |
| quality-dm-seed（A 私聊） | completed | 23 s |

整个套件 15:54 开始，16:00:04 结束，以 `Readiness search unavailable after three bounded attempts` 退出。

`current-entity-update` 失败的原因：更新后的实体卡写为"发布预算为 8100 元（成员于 2026-10-01 正式更新，取代同日较早确认的每月 7600 元）"，Pulsar 和五天都保留了。`hasCurrentBudget`（`e2e/real-agent/quality.mjs:174`）只接受"此前、原先、原预算、历史、previous、historical"这几种历史标注，没有"取代…较早"，因此判为失败。语义上，当前值和历史值都标得正确。但抽取把"每月预算"改成了"发布预算"，丢了周期限定词，这是一个小的蒸馏质量问题。B 的共享召回仍然正确答出了"每月预算：8100 元"。

`dm-distilled-peer-layout` 失败的原因：私聊运行已归档，消息 6 条；OV 的 `session_commit` 正常完成，用时 26.5 秒。但 `memory_diff.json` 中 adds、updates、deletes 都是 0，`memories_extracted` 为空。抽取模型 GLM-5.3-flash 没有把"蓝鹊周报按'风险、进展、下一步'"写成 peer 偏好。可能的原因是用户原话里有"仅用于私聊，不写入公共记忆"，抽取模型把它理解成了不要记录。这一点尚未验证。

readiness 第一次检索被中止，原因是同一时间 OpenRouter embeddings 有一次耗时 36 s 的慢调用；后两次检索正常返回，但没有可召回的事实。这是真实的抽取质量失败，不是基础设施故障。上一轮[蒸馏质量报告](distillation-quality-2026-10-01.md)中，同一检查曾经通过，说明这条用例在当前模型下不稳定。

## 4. 401 统计（真实链路）

### OpenViking（`deploy/observers/ovmem_httpx.py`，HTTPX 边界）

| 套件 | endpoint | HTTP | `authorization_token_present` | `provider_auth_reason` | 次数 |
| --- | --- | --- | --- | --- | --- |
| basic | `/api/v1/embeddings` | 200 | true | — | 130 |
| basic | `/api/v1/chat/completions` | 200 | true | — | 20 |
| quality | `/api/v1/embeddings` | 200 | true | — | 129 |
| quality | `/api/v1/chat/completions` | 200 | true | — | 24 |

没有传输错误，也没有重定向。embeddings 的 p50 为 677 ms，p95 为 26.1 s，最大 40.6 s；OV 日志中有 66 条 `embedding slow call`。chat 的 p50 为 9.5 s，最大 26.5 s。

OV 日志另有 `/api/v1/rerank` 503 Service Unavailable 5 次，集中在 15:56–15:57，均回退为纯向量检索，不是 401。注意：重排走的是 `requests`，不经过 HTTPX 观测，所以上表不含重排；重排的认证形态目前只能看 OV 日志。

18 次 `session_commit` 全部 `completed`，没有出现 `SessionCommit: Expecting value` 或卡在 pending，本轮不需要重启 OV。

### OpenCode（`deploy/observers/opencode.mjs`，provider fetch 边界）

| 套件 | endpoint | HTTP | `authorization_token_present` | `provider_auth_reason` | 次数 |
| --- | --- | --- | --- | --- | --- |
| basic | `/api/v1/chat/completions` | 200 | true | — | 23 |
| quality | `/api/v1/chat/completions` | 200 | true | — | 15 |

所有请求的 `authorization_scheme` 都是 `bearer`。插件日志、OV 日志里没有 `401`、`Missing Authentication header`、`User not found.` 或 `No cookie auth credentials found`。

basic 和 quality 默认不加载 OpenCode 观测。本轮为了采集数据，在本地临时给这两个套件加载了 `opencode.mjs`，并设置 `OVMEM_PROVIDER_DIAGNOSTICS*`；没有加载受控故障插件。这个改动运行后已还原，没有提交。

## 5. 成本估算

| 部分 | 依据 | 估算 |
| --- | --- | --- |
| 受控实验 | 约 2,245 / 70 token | < 0.001 美元 |
| 智能体（gpt-5.4-mini，8 个任务） | 输入 179,888、输出 5,399、缓存读 437,760 token | ≈ 0.19 美元 |
| OV 抽取（glm-5.3-flash，18 次提交） | prompt 244,856、completion 18,835 token | ≈ 0.046 美元 |
| OV 向量与重排 | 提交 8,953 token，另有检索查询 | < 0.001 美元 |
| 合计 | OpenRouter `/api/v1/key` 报告当日用量 0.249 美元 | ≈ 0.25 美元 |

单价取自 OpenRouter `/api/v1/models` 的公开价格。当日用量包括本轮全部调用。

## 6. 环境与过程

- Multica 为匿名浅克隆，CLI 版本号为 `v0.6.0-11-gd061e93`；PostgreSQL 16 已迁移到 `563`；插件证书由本地 dev CA 签发。
- `NODE_EXTRA_CA_CERTS` 使用出口代理 CA 加 dev CA 的合并文件。
- OpenCode 冷启动预热用时 0.93 s，daemon 一次注册成功。
- OV 配置中的密钥通过 `${OPENROUTER_API_KEY}` 展开。`OV_ROOT_KEY` 等本地随机凭据只保存在会话临时目录。报告、JSON 和提交中都不含任何凭据。

## 7. 需要用户决定的事项

1. `run.mjs:190` 的 `cross-task-recall`：建议改为在全部 `status=ok` 的召回中查找被评论引用的 URI，不再只看第一个。这样智能体先空查、再改写查询的正常行为不会被误判。
2. `quality.mjs:174` 的 `hasCurrentBudget`：建议把"取代、已被取代、较早、superseded"加入历史标注；是否要求实体卡保留"每月"，由用户决定。
3. 私聊偏好抽取产出为 0：建议调整用例措辞，或调整 memory-policy，让"仅用于私聊、不写入公共记忆"在私聊范围内仍被记为 peer 偏好。这涉及模板策略，未改动。
4. OV 重排不在观测范围内：如果需要完整的 401 归因，建议把 `requests` 边界也纳入 `ovmem_httpx` 观测。
5. 本环境无法复现 401：建议在原出错环境部署 9cc7a9a 的观测字段。只要出现 `provider_auth_reason=empty_bearer_token`，就能确认是空密钥注入。

## 8. 后续跟进（同日）

- **`cross-task-recall` 的更正。** 这项失败不只是验证器问题。RAM-2 第一次召回的查询是 `issue <本 issue UUID> context or related decisions for ovmem-real-agent-muppmufp`，没有任何业务词。插件的业务查询兜底本应改用 issue 的业务目标，但它只认一组固定的英文通用词，这里多出的 "or"、"for" 和工作区名让它没有触发，返回里也没有 `query_rewritten_from`。现已修复：查询里出现本运行自己的 issue UUID、编号或任务 UUID 时，在原措辞前补入该 issue 的业务目标；通用词表也加入了常见英文虚词和中文通用词。`run.mjs` 改为在全部成功的召回里查找被引用的 URI，并要求每次召回都绑定到本次运行。
- **`current-entity-update`。** 判定用的实体卡（`entities/项目/苍鹭.md`）只有一行同时含 8100 和 7600，写法是"取代同日较早确认的每月 7600 元"。`hasCurrentBudget` 已接受"取代 / 替代 / 较早 / superseded"等标注，以及"7600 已被取代"这种后置写法；用这张卡的原文核验，现在判为通过。同时记录两处蒸馏偏差，都未改动：
  - A 的实体卡写成"苍鹭（RAM-1）"，带了任务编号；
  - B 的任务范围卡在 Relations 里写了不存在的"RAM-2"任务。
- **重排观测。** OV 观测器已覆盖 `requests` 库，记录里用 `client=requests` 区分。另修复一个问题：旧版观测器在 token 为空时会丢掉 cf-ray 等请求 ID。
- **第 7 节第 5 条的更正。** 由于上面这个丢 ID 的问题，旧报告里保留了 cf-ray 的 OV 401 样本，说明这些请求在 SDK 边界带着非空 token。所以 `no_bearer_token`（原名 `empty_bearer_token`）本身不能证明"进程拿到了空密钥"，要和同一请求的 `authorization_token_present` 一起看。详见 [401 归因复核](auth-401-diagnosis-2026-10-01.md) 的"后续复核"。
