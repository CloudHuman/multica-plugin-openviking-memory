# 真实模型 real-agent：原生抽取与账号级规则各 3 轮 — 2026-10-02 UTC

本报告接续[前一轮对比](real-agent-2026-10-01-native-vs-account.md)，用于判断账号级规则是否值得在测试之外推荐。运行前已按用户决定改动三处（`45fb0a5`）：

- 推荐配置去掉 `extraction_output_format: "json"`，使用 OV 默认输出格式；
- 账号级规则的通用部分只写一份，放在 entities；
- quality 验证器接受“7600 元（之前的约定）”这类历史标注。

`7b066e0` 另外让 `memoryPolicy.digest` 覆盖实际写入 OV 的模板内容。

运行在 `7b066e0` 上，使用真实 `OPENROUTER_API_KEY`，在本会话的容器内执行（容器重启后重新拉起服务）。环境：

- **链路**：补丁版 Multica（`43b0571` + 4 个补丁提交，CLI `v0.6.0-11-g959fbae`）官方 daemon、OpenCode 1.17.7、OpenViking 0.4.22。
- **OV 配置**：原样使用 `deploy/ov.openrouter.conf.example`（已无 `memory` 一节），只改了本地端口和存储目录，并把抽取调用指向本地转发代理。代理只记录请求体概要和模型输出，不记录请求头。
- **模型**：执行模型为 `openrouter/openai/gpt-5.4-mini`，抽取、向量、重排分别用 `z-ai/glm-5.3-flash`、`qwen/qwen3-embedding-8b`、`qwen/qwen3-reranker-8b`。
- **运行方式**：只跑 quality 套件，native 与 account 交替各 3 轮，都设置 `REAL_AGENT_OBSERVE_PROVIDER=1`。两种模式都在插件首次使用前预建 OV 账户，插件走同一路径。

## 结论

1. **完整通过**：account 3 轮中 2 轮完整通过（15/15），native 0 轮。按修正后的验证器重判后结论不变。
2. **account 明显更好的两项**：
   - 持久偏好单独成条：native 0/3，account 2/3。native 都把“代码注释用中文”写进实体卡，没有生成偏好记忆。
   - 私聊版式抽取：native 2/3，account 3/3。native 第 3 轮把“仅用于私聊、不写入公共记忆”理解成不要记，peer 空间里什么都没抽出，套件停在私聊就绪检查。
3. **两种模式都做到的**：
   - 事实保真，8100 为当前值且 7600 标为历史（重判后各 3/3），实体 URI 稳定；
   - 两次共享晋升全部被接受（6/6），B 从共享记忆取回全部当前事实（6/6），复用记忆清洁度检查全部通过；
   - 6 轮的抽取输出都是单个代码块，没有空正文，前一轮 json 格式下的空卡没有再出现。
4. **规则没有解决的**：
   - 实体卡带 issue 编号：6/6，两种模式都有。规则里的禁令基本无效。
   - 当前 8100 那一行写“每月”：native 1/3，account 0/3。测试的更新评论本身写作“发布预算”。
   - account 第 3 轮只生成了实体卡，既没有事件也没有单独的偏好，因此 `historical-budget-retained` 与 `lasting-preference-retained` 失败。
5. **代价**：
   - 抽取的系统提示词从 28,097 / 30,308 增至 34,191 / 36,402 字符（+6.1K，约 +22%）。精简前是 +13.7K，约 +45%。
   - 单轮花费差别不大：native $0.108–0.145，account $0.130–0.146。
6. **验证器又发现一处漏判，已修复并补测试**：native 第 1 轮写的是“发布预算为 8100 元（2026-10-02 由 7600 元调整更新…）”，旧验证器不认“由 7600 元调整”。用两天共 10 张已存卡片重判：两次漏判都变为通过，原来通过的仍通过，没有新增误判。
7. **召回超时**：native 有 3/15 次召回出现超时范围，account 0/15。向量 p95 在 3.5–48 s。
8. **插件侧观察**：native 第 3 轮的卡写进了“历史检索为空不影响确认”和“智能体 … 在 RAM-1 任务上下文中发表评论”，仍被晋升。插件的检索结论过滤器不认“检索为空”这个说法；直接放宽会误删“检索结果为空时显示提示”这类正常的产品事实，本轮未改。
9. **花费**：6 轮共 $0.804，另有预检 $0.0016。

## 1. 逐项结果

| 检查 | native 1 | native 2 | native 3 | account 1 | account 2 | account 3 |
| --- | --- | --- | --- | --- | --- | --- |
| runtime | PASS | PASS | PASS | PASS | PASS | PASS |
| automatic-fact-fidelity | PASS | PASS | PASS | PASS | PASS | PASS |
| lasting-preference-retained | **FAIL** | **FAIL** | **FAIL** | PASS | PASS | **FAIL** |
| no-active-write-shortcut | PASS | PASS | PASS | PASS | PASS | PASS |
| current-entity-update | **FAIL**（漏判，重判 PASS） | PASS | PASS | PASS | PASS | PASS |
| historical-budget-retained | PASS | PASS | PASS | PASS | PASS | **FAIL** |
| entity-category-stable | PASS | PASS | PASS | PASS | PASS | PASS |
| updated-uri-repromoted | PASS | PASS | PASS | PASS | PASS | PASS |
| real-B-current-shared-recall | PASS | PASS | PASS | PASS | PASS | PASS |
| real-B-task-delivery | PASS | PASS | PASS | PASS | PASS | PASS |
| dm-distilled-peer-layout | PASS | PASS | **FAIL** | PASS | PASS | PASS |
| real-DM-layout-recall | PASS | PASS | 未执行 | PASS | PASS | PASS |
| peer-audit-coverage | PASS | PASS | 未执行 | PASS | PASS | PASS |
| reusable-memory-hygiene | PASS | PASS | 未执行 | PASS | PASS | PASS |
| runtime-markers-filtered | PASS | PASS | 未执行 | PASS | PASS | PASS |
| 合计（按运行时） | 13/15 | 14/15 | 9/11，停在私聊就绪检查 | 15/15 | 15/15 | 13/15 |

所有完成审计的运行，`qualityFindings` 都为 0。`entityFindings` 在任务范围和共享范围的卡上都是 `entity-issue-key`。

## 2. 实体卡（任务范围，更新后）

| 运行 | 标题 | 8100 为当前值（重判） | 8100 行写“每月” | issue 编号 | 单独的偏好 | 事件数 |
| --- | --- | --- | --- | --- | --- | --- |
| native 1 | 苍鹭 | 是 | 否 | 有（“（RAM-1）”，事件一节两处） | 无 | 2 |
| native 2 | RAM-1 苍鹭 | 是 | 否 | 有（标题与描述） | 无 | 1 |
| native 3 | 苍鹭蒸馏项目 | 是 | 是 | 有（描述与备注） | 无 | 4 |
| account 1 | 苍鹭 | 是 | 否（“此前为每月 7600 元”） | 有（“任务 RAM-1 相关”） | 有 | 1 |
| account 2 | 苍鹭 | 是 | 否 | 有（“对应任务编号 RAM-1”） | 有 | 3 |
| account 3 | 苍鹭 | 是 | 否（“历史约定：每月预算原为 7600 元”） | 有（“记录于 RAM-1 …”） | 无 | 0 |

native 第 3 轮的卡（节选）：

```
# 苍鹭蒸馏项目
用户参与的一个项目（RAM-1），发布与运维约定已由成员正式确认。
## 预算与运维
- 每月预算为 8100 元（2026-10-02 调整，其他约定不变，以本次更新为准）。
## 备注
- 2026-10-02 成员正式确认上述约定，作为直接证据，历史检索为空不影响确认。
- 2026-10-02 智能体 948a53be-… 在 RAM-1 任务上下文中发表评论，确认苍鹭发布预算调整为 8100 元，…
```

account 第 2 轮的卡（节选）：

```
# 苍鹭
## 预算与计划
- 发布预算现为 8100 元（2026-10-02 成员明确以本次更新为准）。
- 历史预算为 7600 元（2026-10-02 早期确认，已被 8100 元取代）。
## 工作约定
- 该项目代码注释统一使用中文（2026-10-02 成员确认的长期约定）。
- 对应任务编号 RAM-1。
```

## 3. 验证器修正与重判

`hasCurrentBudget` 新增两类历史写法：

- “由 / 从 7600 元调整 / 上调 / 改为…”；
- 7600 后紧跟的括号注释写明它是旧值，如“之前的约定”“原预算”“已作废”。

以下写法仍判失败：

- 注释里带其他金额，如“（之前为 8100 元）”；
- 注释写明仍然有效或当前执行；
- 反向调整“由 8100 元调整为 7600 元”；
- 没有标注的 7600。

测试用到了两天实际存下的卡片和这些对抗写法。

| 卡片 | 原判定 | 重判 |
| --- | --- | --- |
| 10-01 native（json） | PASS | PASS |
| 10-01 account（json） | PASS | PASS |
| 10-01 account（OV 默认） | FAIL | PASS |
| 10-02 native 1 | FAIL | PASS |
| 10-02 native 2 / 3、account 1–3 | PASS | PASS |

## 4. 提示词与输出格式

| 抽取的系统提示词字符数 | native | account |
| --- | --- | --- |
| 本轮（通用规则只写一份） | 28,097 / 30,308 | 34,191 / 36,402 |
| 前一轮重放（json 格式，通用规则重复 4 遍，同一输入） | 30,440 | 44,098 |

记录代理收到的抽取输出都是单个 python 代码块，没有多段输出，也没有空正文。

## 5. 延迟与超时

| 运行 | 时长（含结束后 60 s 等待） | 向量 p95 | 出现超时范围的召回 |
| --- | --- | --- | --- |
| native 1 | 7.4 min | 22.0 s | 1/6 |
| account 1 | 6.1 min | 11.0 s | 0/5 |
| native 2 | 5.5 min | 3.5 s | 0/5 |
| account 2 | 6.0 min | 5.6 s | 0/5 |
| native 3 | 5.7 min | 6.7 s | 2/4 |
| account 3 | 6.3 min | 48.4 s | 0/5 |

本轮向量延迟整体低于前一轮，召回超时没有导致检查失败。

## 6. 成本

| 运行 | 花费 |
| --- | --- |
| native 1 / 2 / 3 | $0.1453 / $0.1365 / $0.1081 |
| account 1 / 2 / 3 | $0.1381 / $0.1455 / $0.1304 |
| 合计（1.97616605 − 1.17222812） | **$0.8039** |

## 7. 环境与过程

- 容器重启后，恢复 hosts 条目与合并 CA，重新启动 PostgreSQL、Multica 服务端、OV 和转发代理。OV 使用新数据目录。
- 预检确认两种模式的账户预建正常，OV 接受精简后的模板；一次 account 抽取的提示词为 34,191 字符，输出为 python 格式。
- 运行期间不改动工作区代码。验证器的第二处修正在 6 轮结束后进行，重判在离线完成。
- 报告、JSON 和提交中都不含凭据。

## 8. 需要用户决定的事项

1. **账号级规则的定位**：
   - 规则的收益集中在两点：持久偏好单独成条（0/3 → 2/3），私聊偏好不会因“不写入公共记忆”而漏记（2/3 → 3/3）。
   - issue 编号它挡不住，每次抽取还要多约 22% 的提示词。
   - 建议保持为测试和可选的运维工具，不作为插件默认部署的一部分。
2. **实体卡里的 issue 编号（两种模式 6/6）**：可以在插件输入侧处理，例如归档时用 issue 标题替代编号，让 OV 看不到编号；也可以继续只作为观察。
3. **插件的检索结论过滤器是否识别“检索为空”**：需要在漏掉检索结论和误删正常产品事实之间取舍。
4. **`lasting-preference-retained` 是否继续要求偏好单独成条**：目前 native 会把偏好写在实体卡里，事实没有丢，但不会作为偏好被召回和应用。
