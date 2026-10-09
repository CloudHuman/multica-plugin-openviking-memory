# 真实模型 real-agent：工作区规则经安装配置生效、清理后晋升 — 2026-10-08 UTC

本报告接续 [10-02 的 3 轮对比](real-agent-2026-10-02-native-vs-account-x3.md)。运行前按用户决定改了两处（`177b10e`）：

- **清理后晋升**：卡片里夹杂临时执行指令或检索结论时，去掉这些句子、晋升其余事实；
- **偏好检查放宽**：“代码注释用中文”写成单独的偏好，或写成项目实体卡的一行，都算保留，报告记录实际存放位置（`preferenceStorage`）。

同时首次用真实模型验证 `3851511` 的三项改动：

- 工作区抽取规则 `memory_rules`；
- 归档时用 issue 标题代替编号；
- 把“检索为空”识别为检索结论。

工作区规则这次走的是生产路径：测试脚本像工作区管理员一样，经 Multica 的配置接口写入安装配置；Multica 随 hook 投递配置；插件把规则写进该工作区 OV 账户的模板。

运行在 `177b10e` 上，使用真实 `OPENROUTER_API_KEY`，在本会话的容器内执行（容器重启后重新拉起服务）。环境与 10-02 相同：

- **链路**：
  - 补丁版 Multica（CLI `v0.6.0-11-g959fbae`）的官方 daemon；
  - OpenCode 1.17.7；
  - OpenViking 0.4.22。
- **OV 配置**：
  - 原样使用 `deploy/ov.openrouter.conf.example`，只改了本地端口和存储目录（新建的空目录）；
  - 抽取调用指向本地转发代理。代理只记录请求体概要和模型输出，不记录请求头。
- **模型**：
  - 执行模型：`openrouter/openai/gpt-5.4-mini`；
  - 抽取：`z-ai/glm-5.3-flash`；
  - 向量：`qwen/qwen3-embedding-8b`；
  - 重排：`qwen/qwen3-reranker-8b`。
- **运行方式**：
  - quality 套件，native 与 config 各 1 轮，都设置 `REAL_AGENT_OBSERVE_PROVIDER=1`；
  - config 使用 `e2e/real-agent/memory-rules.txt`：10 条规则，1,906 字节，不含测试用例的具体值。这份文件之后移到 [`deploy/memory-rules.example.txt`](../deploy/memory-rules.example.txt) 作为参考模板，规则内容不变，只改了开头的注释。

## 结论

1. **通过情况**：
   - config 16/16 全部通过（比 native 多一项 `memory-rules-applied`）。
   - native 14/15，失败的是复用记忆清洁度，原因见第 5 条。
2. **工作区规则经安装配置生效**：
   - Multica 投递的 hook 带上了 `memory_rules`。
   - 插件在第一次提交前 94 ms 写好该账户的 profile、events、preferences、entities 四类模板，状态为 applied，共 10 条。
   - 本轮 12 次抽取请求全部带规则标题；native 0/12。
   - 抽取的系统提示词：
     - native：28,097 / 30,308 字符；
     - config：30,634 / 32,845 字符，约多 2.5K（+9%）；
     - 10-02 的完整测试规则是 +22%。
3. **标题代替编号有效**：
   - 两轮的实体卡、共享卡都没有 issue 编号（10-02 的 6 轮全部带编号）。
   - 归档里的任务行现在写成“[任务上下文] 「苍鹭蒸馏质量初始约定」”。
4. **持久偏好**：
   - 两轮都单独生成了偏好记忆，`preferenceStorage` 都是 `preference`；两张实体卡里也各有这一行。
   - native 这次做到了（10-02 是 0/3），但只有 1 轮，不能据此说 native 已经改善。
5. **私聊偏好里的执行指令（native）**：
   - native 把“要求回复前先调用 memory-recall 核实证据”写进了“蓝鹊周报”偏好，被审计判为 execution-control。
   - config 的同一条只有版式和“仅用于私聊”。规则第 2 条正是针对这种情况。
   - 新会话里实际召回到的摘录已去掉这句（`content_filtered`），私聊记忆也不参与晋升，所以实际影响有限；但这是原生抽取的真实缺陷。
6. **清理后晋升本轮没有触发**：
   - 两轮各两次晋升，4 次都按原样通过，`cleaned` 为空，`skipped` 为空。原因是标题代替编号后，卡片里不再有编号和执行指令。
   - 这条路径目前只有单元测试覆盖，包括 10-01 那张因“不修改代码、不主动记录记忆”被整卡拦下的真实卡片。
7. **“检索为空”没有进入可复用记忆**：
   - 种子任务原文里有“历史检索为空不影响确认”，两轮都没写进实体卡、偏好或共享空间。
   - 这类说法只出现在事件的会话记录和摘要里；事件按设计保留检索结论，作为当时的历史记录。
   - 过滤器本轮没有可过滤的对象。
8. **其他观察**：
   - **config 的事件更细**：任务空间 7 个文件（5 个事件），native 3 个（1 个事件）。config 给 8100 的调整单独记了一个事件；native 没有，它的历史预算检查靠 7600 那次确认的事件通过。
   - **当前值的“每月”**：config 卡的当前值写成“发布预算为 8100 元（…此前为每月 7600 元…）”，当前这一行没写“每月”；native 写成“项目每月预算为 8100 元”。更新评论原文是“发布预算调整为 8100 元”。规则里“月度金额保持月度”这一条没有完全生效。
   - **事件摘要里的执行指令**：config 的 8100 事件摘要带了“成员要求先调用 memory-recall … 不修改代码 …”。事件记录发生过的事，召回摘录会去掉这些句子。
9. **请求**：
   - OV 侧向量和重排：448 次 200，另有 10 次重排返回 429（OpenRouter 限流），没有 401。
   - OpenCode 38 次请求全部 200。
   - 经记录代理的抽取模型调用 46 次全部 200。
10. **向量延迟**：
    - p95：native 19.4 s，config 27.0 s；最长 46.5 s。
    - 召回中出现超时范围：native 1/5，config 2/5。
    - config 的私聊就绪检查第 3 次才通过。
    - 按此前决定，本轮不处理。
11. **花费**：native $0.1354，config $0.1344，共 $0.2698。

## 1. 逐项结果

| 检查 | native | config |
| --- | --- | --- |
| runtime | PASS | PASS |
| automatic-fact-fidelity | PASS | PASS |
| lasting-preference-retained | PASS（preference） | PASS（preference） |
| no-active-write-shortcut | PASS | PASS |
| current-entity-update | PASS | PASS |
| historical-budget-retained | PASS | PASS |
| entity-category-stable | PASS | PASS |
| updated-uri-repromoted | PASS | PASS |
| real-B-current-shared-recall | PASS | PASS |
| real-B-task-delivery | PASS | PASS |
| dm-distilled-peer-layout | PASS | PASS |
| real-DM-layout-recall | PASS | PASS |
| peer-audit-coverage | PASS | PASS |
| reusable-memory-hygiene | **FAIL**（私聊偏好带执行指令） | PASS |
| runtime-markers-filtered | PASS | PASS |
| memory-rules-applied | — | PASS |
| 合计 | 14/15 | 16/16 |
| 用时 / 花费 | 6.2 分钟 / $0.1354 | 9.3 分钟 / $0.1344 |

## 2. 工作区规则的生效过程

| 时间（UTC） | 事件 |
| --- | --- |
| 03:25:13 | config 轮开始。安装插件后，`PUT /api/workspaces/{ws}/plugins/{installationId}/config` 写入 `memory_rules`（1,906 字节，未超过 4,096 字节上限） |
| 03:25:33.793 | 种子任务完成，Multica 投递 `task.completed`，hook 正文带 `config.memory_rules`。插件解析出 10 条规则，写入四类账号级模板，状态 applied |
| 03:25:33.887 | 第一次提交（`memoryRules.settled` 之后才提交） |
| 运行结束 | 四类模板均为 `custom`，且带 `## Workspace memory rules` 标题；插件状态的规则条数与文件一致 |

抽取请求统计：

| | native | config |
| --- | --- | --- |
| 带系统提示词的抽取调用 | 12 | 12 |
| 其中带工作区规则标题 | 0 | 12 |
| 系统提示词字符数 | 28,097 / 30,308 | 30,634 / 32,845 |

## 3. 卡片

native，更新后的任务空间实体卡（共享空间的副本措辞略有精简，事实相同）：

```
# 苍鹭
用户参与的「苍鹭」发布项目，已确认其技术栈与资源约定。

## 关键事实
- 苍鹭发布使用 Apache Pulsar 作为消息中间件（2026-10-08 确认）。
- 项目每月预算为 8100 元（2026-10-08 更新，此前为 7600 元，以本次为准）。
- 双写方案持续五天（2026-10-08 确认）。
- 该项目代码注释统一使用中文（2026-10-08 约定）。
```

config，更新后：

```
# 苍鹭
成员确认的发布项目，涉及消息系统与预算安排。

## 技术选型
- 发布使用 Apache Pulsar（2026-10-08 成员确认）
- 采用双写方案，持续五天

## 预算与约定
- 发布预算为 8100 元（2026-10-08 更新，此前为每月 7600 元，明确以本次更新为准）
- 项目代码注释一律使用中文
```

单独的偏好记忆：

- native：`preferences/user/代码注释语言.md` —“「苍鹭」项目的代码注释统一使用中文。”
- config：`preferences/user/苍鹭项目代码注释语言.md` —“苍鹭项目的代码注释一律使用中文。”

私聊配对空间的周报偏好：

```
native：
- “蓝鹊周报”固定按三个中文标题排版：风险、进展、下一步，风险放第一。
- 该约定仅用于私聊场景，不写入公共记忆。
- 2026-10-08 用户首次提出该约定，要求回复前先调用 memory-recall 核实证据。   ← execution-control

config：
- “蓝鹊周报”是成员的私人排版约定：固定按“风险、进展、下一步”三个中文标题组织，风险放在第一。
- 该约定仅用于私聊，不写入公共记忆、不用于群聊或公开渠道。
```

## 4. 清理后晋升

两轮各晋升两次（种子任务后一次，预算更新后一次）。卡片本身没有执行指令和检索结论，4 次都原样晋升：结果里没有 `cleaned` 字段，`skipped` 为空。共享空间各只有一张苍鹭卡，没有编号，也没有“检索为空”。

清理路径由单元测试覆盖：

- 清理后提交的内容与原卡的事实一致，去掉的类别出现在 `promoted[].cleaned`；
- 只改了被去掉的句子时不会再次晋升；
- 整张卡只剩执行指令，或带运行时说明，仍然不晋升；
- 10-01 那张因一行“不修改代码、不主动记录记忆”被整卡拦下的真实卡片，现在会去掉这一行后晋升。

## 5. 对后续的含义

- `memory_rules` 的生产路径已经端到端跑通：管理员写入配置，规则在首次提交前生效，只作用于该工作区自己的账户。默认仍然是 OV 原生抽取。
- 这次能看出差别的只有私聊偏好里的执行指令。只有 1 轮，其余差别（偏好单独成条、事件粒度、“每月”）都需要更多轮次才能下结论。
- 仍待处理：
  - benchmark 套件在干净环境重跑（上次在 401 环境里是 0/27）；
  - 向量延迟，已决定暂不处理；
  - 补丁上游化。

## 复现

```bash
# 服务就绪后（补丁版 Multica、OpenViking 0.4.22、记录代理）
REAL_AGENT_SUITE=quality REAL_AGENT_MEMORY_POLICY=native node e2e/real-agent/run.mjs
REAL_AGENT_SUITE=quality REAL_AGENT_MEMORY_POLICY=config node e2e/real-agent/run.mjs
```

两种方式都需要 `MULTICA_RUN_REAL_AGENT_SMOKE=1`、`OV_ROOT_KEY`、`OVMEM_TLS_CERT` / `OVMEM_TLS_KEY` 和 `OPENROUTER_API_KEY`，见 [`e2e/real-agent/README.md`](../e2e/real-agent/README.md)。
