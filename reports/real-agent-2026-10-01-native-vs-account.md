# 真实模型 real-agent：原生抽取与账号级规则对比 — 2026-10-01 UTC

本次在 `fix/review-hardening` 的 `7b4918d` 上运行，使用真实 `OPENROUTER_API_KEY`，在本会话的容器内执行。链路为补丁版 Multica（`43b0571` + 4 个补丁提交，CLI `v0.6.0-11-g959fbae`）官方 daemon、OpenCode 1.17.7、OpenViking 0.4.22。执行模型为 `openrouter/openai/gpt-5.4-mini`；OV 的抽取、向量、重排分别用 `z-ai/glm-5.3-flash`、`qwen/qwen3-embedding-8b`、`qwen/qwen3-reranker-8b`。所有运行都设置了 `REAL_AGENT_OBSERVE_PROVIDER=1`。

对比对象：

- **native**：`REAL_AGENT_MEMORY_POLICY=native`，OV 原生模板。
- **account**：`REAL_AGENT_MEMORY_POLICY=account`，测试工作区的 OV 账户写入 `e2e/real-agent/memory-policy.json`（摘要 `e7835e8648225849`），只追加在 profile、events、preferences、entities 的描述后。

两种模式都在插件首次使用前预建 OV 账户，插件走同一路径。每轮都确认实例模板不带这套规则。每轮新建 Multica 工作区和 OV 账户，互不共享记忆。

OV 实例配置分两组：

- **A 组（4 轮）**：原样使用 `deploy/ov.openrouter.conf.example`，含 `memory.extraction_output_format: "json"`。
- **B 组（2 轮，只跑 quality）**：去掉 `memory` 一节，完全使用 OV 默认值（输出格式为 python）。抽取调用经本地转发代理到 OpenRouter，代理只记录请求体概要和模型输出，不记录请求头。

## 结论

1. **插件侧的检查在两种模式下都通过**。包括签名代理工具调用、归档清理、召回绑定运行、共享晋升准入、peer 命名空间和复用记忆清洁度。所有失败都不来自插件代码。
2. **A 组 native 的 quality 停在共享就绪检查，根因是推荐配置里的 `extraction_output_format: "json"`**：
   - 共享范围的晋升输入完整，但 OV 新建的实体卡正文为空（`memory_diff` 中 `after: ""`），第二次晋升更新后仍为空。
   - 模型在 json 格式下先输出一段空补丁（`"content": {"blocks": [{"search": "", "replace": ""}]}`），再补一段“修正后的最终输出”。OV 按第一个 `{` 到最后一个 `}` 解析，最终用了空补丁。
   - 同一条晋升消息各重放 4 次：json + native 1/4 空卡，json + account 0/4，OV 默认格式 0/4。
   - OV 默认格式在 4 次重放和 2 轮套件中，共 17 次抽取输出都是单个代码块，没有空正文。
   - 这项设置是 9/30 随 mock 测试配置带入推荐配置的，没有记录理由。
3. **B 组（OV 默认值）native 的 quality 停在共享晋升**：
   - 原生抽取没有单独生成“代码注释用中文”的偏好；
   - 实体卡标题写成“苍鹭（RAM-1 项目）”，还混入“处理该任务时要求按证据回复、不修改代码、不主动记录记忆”；
   - 插件的晋升过滤据此判定 `execution-control`，拒绝晋升，共享范围因此为空。这是插件按设计拦截。
   - 同配置下 account 的偏好独立成条，卡片干净，晋升被接受，B 取回了全部当前事实。
4. **账号级规则的效果（每种配置各 1 轮，样本小）**：
   - **issue 编号**：quality 两轮 account 的卡里都没有。basic account 的卡在“关联方”一节仍有“在任务 RAM-1 下确认方案”，记为 1 条 `entityFindings`。native 的 quality 卡两轮都带 RAM-1。
   - **金额周期**：A 组 account 保留了“每月预算为 8100 元”；B 组 account 把更新另起一条“发布预算调整为 8100 元”。测试的更新评论本身就写作“苍鹭发布预算调整为 8100 元”，命名漂移有一部分来自输入。
   - **代价**：同一输入下，抽取的系统提示词从 30,440 增至 44,098 字符（+13.7K，约 +45%），其中 10.4K 是重复 4 遍的通用规则。
5. **与模式无关的失败来自召回超时**：
   - 向量请求的 p95 为 24–46 s，最长 53 s，召回预算是 15 s。
   - basic native 的 `no-answer` 判为“无法确认”：新检查按设计生效，召回有范围超时。
   - 两轮 account 的私聊召回都是全部范围超时，智能体如实回答“暂时无法确认”。
6. **验证器漏判一项**：B 组 account 的卡写成“每月预算为 7600 元（2026-10-01 之前的约定）”，当前值另起一条为 8100。`hasCurrentBudget` 的历史词表没有“之前”，因此判失败。本轮未改验证器。
7. **没有 401**：共 1,136 次带认证的请求：
   - OV 观测 987 次：对话补全 76、向量 588、重排 323，其中重排有 10 次 503；
   - OpenCode 96 次；
   - 记录代理 53 次，全部 200。
8. **花费 $0.659**：包含 6 轮套件、1 次预检和 24 次重放调用。

## 1. basic（A 组）

| 检查 | native | account |
| --- | --- | --- |
| runtime | PASS | PASS |
| actual-tools | PASS | PASS |
| successful-memory-tools | PASS | PASS |
| automatic-extraction | PASS | PASS |
| archive-prompt-hygiene | PASS | PASS |
| active-memory-index | PASS | PASS |
| recall-bound-to-run | PASS | PASS |
| cross-task-recall | PASS | PASS |
| no-answer | **FAIL**（召回有范围超时，判为无法确认） | PASS |
| runtime-read-archive-hygiene | PASS | PASS |
| runtime-read-exercised | PASS | PASS |
| distilled-prompt-hygiene | PASS | PASS |
| memory-quality | PASS | PASS |

抽取结果：

- **native 共 2 个文件**：
  - 智能体主动写入的 case；
  - RAM-1 任务范围的 event，摘要里写有“在 RAM-1 海棠迁移方案确认任务下”。event 不在实体卡检查范围内。
  - 没有生成实体卡。
- **account 共 4 个文件**：
  - 同样的 case 和 event；
  - 两张实体卡：RAM-1 范围的 `项目/海棠迁移项目.md`；RAM-2 范围的 `迁移方案/海棠迁移方案.md`，由召回内容生成，注明“来源：2026-10-01 召回的海棠迁移方案确认案例”。
  - 前一张的“关联方”是“由智能体 … 在任务 RAM-1 下确认方案”，即本轮唯一一条 `entity-issue-key` 观察。

## 2. quality

| 检查 | native（A 组 json） | account（A 组 json） | native（B 组 OV 默认） | account（B 组 OV 默认） |
| --- | --- | --- | --- | --- |
| runtime | PASS | PASS | PASS | PASS |
| automatic-fact-fidelity | PASS | PASS | PASS | PASS |
| lasting-preference-retained | PASS | PASS | **FAIL** | PASS |
| no-active-write-shortcut | PASS | PASS | PASS | PASS |
| current-entity-update | PASS | PASS | 未执行 | **FAIL**（验证器漏判） |
| historical-budget-retained | PASS | PASS | 未执行 | PASS |
| entity-category-stable | PASS | PASS | 未执行 | PASS |
| updated-uri-repromoted | PASS | PASS | 未执行 | PASS |
| real-B-current-shared-recall | 未执行 | PASS | 未执行 | PASS |
| real-B-task-delivery | 未执行 | PASS | 未执行 | PASS |
| dm-distilled-peer-layout | 未执行 | PASS | 未执行 | PASS |
| real-DM-layout-recall | 未执行 | **FAIL**（全部范围超时） | 未执行 | **FAIL**（私聊、共享超时） |
| peer-audit-coverage | 未执行 | PASS | 未执行 | PASS |
| reusable-memory-hygiene | 未执行 | PASS | 未执行 | PASS |
| runtime-markers-filtered | 未执行 | PASS | 未执行 | PASS |
| 停止原因 | 共享就绪检查（空卡） | — | 共享晋升未准入 | — |

account 的两轮审计都没有 `qualityFindings` 和 `entityFindings`。两轮 native 都在审计前停止。

### 2.1 实体卡原文（任务范围）

native（A 组），更新后：

```
# 苍鹭
用户参与的一个项目，关联任务 RAM-1（苍鹭蒸馏质量初始约定）。
## 技术约定
- 发布使用 Apache Pulsar。
- 存在双写机制，持续五天。
## 预算与管理
- 发布预算为 8100 元（2026-10-01 更新，此前为 7600 元）。
## 工作规范
- 项目代码注释统一使用中文。
```

account（A 组），更新后：

```
# 苍鹭
成员于 2026-10-01 正式确认其发布相关约定的项目。
## 关键约定
- 发布使用 Apache Pulsar（成员于 2026-10-01 确认）。
- 每月预算为 8100 元（成员于 2026-10-01 更新确认，明确以本次更新为准；此前确认为 7600 元）。
- 采用双写，持续五天（成员于 2026-10-01 确认）。
- 项目代码注释一律使用中文。
```

native（B 组），更新前（本轮在此停止）：

```
# 苍鹭（RAM-1 项目）
一个正在推进的项目，其蒸馏质量初始约定已在 RAM-1 issue 下由成员正式确认。
## 关键约定
- 发布使用 Apache Pulsar (as of 2026-10-01)
- 每月预算为 7600 元 (as of 2026-10-01)
- 双写持续五天 (as of 2026-10-01)
- 项目代码注释一律使用中文 (as of 2026-10-01)
## 背景
- 约定于 2026-10-01 在 RAM-1「苍鹭蒸馏质量初始约定」任务中按 issue 证据核对确认
- 处理该任务时要求按证据回复、不修改代码、不主动记录记忆
```

插件对这张卡的晋升判定是 `{"eligible": false, "reasons": ["execution-control"]}`。

account（B 组），更新后：

```
# 苍鹭
成员于 2026-10-01 确认的蒸馏质量项目，项目代号为“苍鹭”。
## 关键事实
- 发布使用 Apache Pulsar (as of 2026-10-01)
- 每月预算为 7600 元（2026-10-01 之前的约定）
- 发布预算调整为 8100 元，其他约定不变，以本次更新为准 (as of 2026-10-01)
- 双写持续五天 (as of 2026-10-01)
## 约定
- 项目代码注释一律使用中文 (as of 2026-10-01)
```

### 2.2 A 组 native 的共享空卡

插件两次写入共享范围的晋升消息都完整：第一次是 7600 的卡，第二次是更新后的 8100 卡。OV 的记录如下：

- 第一次 `mc-consolidate-5876065b1cf8`：`adds: [{uri: …/entities/项目/苍鹭.md, after: ""}]`
- 第二次 `mc-consolidate-afef7e1c4b99`：`updates: [{before: "", after: ""}]`

文件只剩 `MEMORY_FIELDS` 元数据（176 字节）。内容读取接口返回空串，就绪检查前两次没有命中 8100，第 3 次在 25 s 时限内超时。

用第一次的晋升消息，在独立账户里重放：

| 配置 | 次数 | 空卡 |
| --- | --- | --- |
| json + native | 4 | 1 |
| json + account | 4 | 0 |
| OV 默认 + native | 4 | 0 |

空卡那次的模型原始输出（节选）：

````
```json
{"entities": [{"page_id": 100, "category": "项目", "name": "苍鹭",
  "content": {"blocks": [{"search": "", "replace": ""}]}}], "delete_ids": []}
```
补充说明：来源卡片内容为完整实体信息，直接新建实体卡。修正后的最终输出：
```json
{"entities": [{"page_id": 100, "category": "项目", "name": "苍鹭", "content": "# 苍鹭\n…"}], …}
```
````

OV 默认格式下，模型 4 次都直接输出 `sdk.create_entities(category=…, name=…, content="""…""")`。json + account 的 0/4 不能说明规则能避免此问题：规则没有涉及输出格式，样本也太小。

### 2.3 验证器漏判

`hasCurrentBudget` 要求含 7600 的每一行都标为历史。“历史”词表在 7600 前面是“此前、原先、历史、取代、较早……”，在 7600 后面是“被取代、superseded”等。B 组 account 的写法是“每月预算为 7600 元（2026-10-01 之前的约定）”，当前值另起一条为 8100，验证器不识别“之前”。如果要放宽，可以在 7600 之后的词表里加入“之前”。

## 3. 账号级规则的提示词代价

| 抽取的系统提示词字符数 | native | account |
| --- | --- | --- |
| 重放，同一输入（json） | 30,440 | 44,098 |
| B 组套件（OV 默认，输入随轮次不同） | 28,097 | 41,712–43,923 |

增加的 13.7K 字符里，通用规则（2,600 字符）追加在 4 类模板中，重复 4 遍，共 10.4K。只保留一份可省约 7.8K。

## 4. 延迟与超时

| 运行 | 时长 | 向量 n | p50 | p95 | 最大 | 受影响的检查 |
| --- | --- | --- | --- | --- | --- | --- |
| basic native | 3.8 min | 101 | 0.96 s | 28.1 s | 28.3 s | no-answer |
| basic account | 4.2 min | 105 | 0.54 s | 25.6 s | 37.6 s | — |
| quality native（A） | 5.0 min | 74 | 0.57 s | 24.1 s | 27.7 s | 就绪检查第 3 次超时 |
| quality account（A） | 8.3 min | 132 | 1.73 s | 25.8 s | 48.6 s | real-DM-layout-recall |
| quality native（B） | 2.4 min | 53 | 0.36 s | 46.2 s | 52.9 s | — |
| quality account（B） | 8.4 min | 123 | 1.90 s | 44.2 s | 50.1 s | real-DM-layout-recall |

召回预算 15 s 小于向量 p95，跨多个范围的召回容易全部超时。智能体在超时时都说明了检索不完整。

## 5. 成本

运行前后 `/api/v1/key` 的 `usage` 之差（每轮结束后等 60 s 再读取）：

| 运行 | 花费 |
| --- | --- |
| basic native | $0.1202 |
| basic account | $0.1170 |
| quality native（A，提前停止） | $0.0678 |
| quality account（A） | $0.1579 |
| 重放与间隔 | $0.0162 |
| quality native（B，提前停止） | $0.0271 |
| quality account（B） | $0.1529 |
| 合计（1.17066176 − 0.51153918） | **$0.6591** |

## 6. 环境与过程

- 本会话容器内复用先前构建的 Multica 和 OpenCode，重新启动 PostgreSQL 16（迁移到 `563`）和 Multica 服务端。OV 使用新数据目录。
- OV 配置只含 `${OPENROUTER_API_KEY}`、`${OV_ROOT_KEY}` 引用。`OV_ROOT_KEY` 为本地随机值，只保存在会话临时目录。
- 正式运行前做了一次抽取预检：账户预建与实例模板检查通过，真实模型抽取 18 s 完成。
- 运行顺序依次为 basic native、basic account、quality native、quality account。B 组在 A 组之后执行，期间 OpenRouter 的向量延迟上升。
- 报告、JSON 和提交中都不含凭据。记录代理不写请求头。

## 7. 需要用户决定的事项

1. **推荐配置是否去掉 `extraction_output_format: "json"`，改用 OV 默认值**：这与“不改 OV 自身”一致，也避开空卡问题。`e2e/real-stack/ov.conf.example` 供 mock 模型使用，仍需保留 json。
2. **账号级规则是否在测试之外也推荐使用**：B 组 native 把执行指令写进了实体卡，晋升被插件拦下；同配置的 account 卡片干净。但每种配置只有 1 轮，建议每种配置至少重复 3 轮再定，每轮 quality 约 $0.15。
3. **是否精简账号级规则**：通用规则只保留一份，每次抽取约可省 7.8K 字符。
4. **`hasCurrentBudget` 是否接受“之前”作为历史标记**。
5. **向量延迟（仍未解决）**：p95 最高 46 s，可选做法是固定上游、直连提供方或自托管。
