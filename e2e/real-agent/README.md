# 真实智能体端到端测试

`run.mjs` 启动正式 Multica daemon，由实际 OpenCode CLI 和模型执行四个任务。脚本只创建工作区、安装插件、绑定 skill、分配任务与读取结果；转写和记忆工具调用均由真实智能体产生。

场景覆盖业务约定的主动记忆、自动归档与抽取、新任务召回四项原有约定并引用 URI、无答案时如实说明，以及专门读取平台 `AGENTS.md` 后的提示词过滤。检查直接读取 OpenViking 的归档和抽取文件。任何检查失败，脚本退出码为非零。

`REAL_AGENT_SUITE=matrix` 使用同一正式 daemon 和两个实际智能体，覆盖以下入口和边界：

| 场景 | 核验 |
| --- | --- |
| 多智能体同一 issue 协作 | A 的归档可由接手的 B 召回，并在交付回复中引用 URI |
| 各自公共记忆 | 晋升前 B 不搜索 A 的空间，不复述只存于 A 空间的事实 |
| @mention 委派 | A 实际发布交接评论，B 由平台调度；评论进入 A → B 通道 |
| 成员评论、手动重跑、唤醒 | 由真实入口启动运行，召回绑定正确 issue；当前明确更新优先 |
| 私聊 | 新会话仍能召回相同成员与智能体的配对记忆；另一智能体不能访问 |
| 快速创建 | 实际创建 issue，保留 quick-create 来源绑定，运行归档落入 run 空间 |
| 自动化 | 手动触发、真实本地 webhook、定时调度、create-issue 模式分别执行 |
| 并发 | 两个实际运行时间重叠，召回范围与最终业务标记不串任务 |
| 共享晋升 | 真实管理员操作后，B 可从共享范围召回 A 的业务约定；私聊范围不参与晋升 |
| 运行中追加 | 实测当前运行时能力；HTTP 412 标记为 unsupported，不能算完整通过 |

矩阵不模拟智能体转写或代替智能体调用工具。本地 webhook 只调用隔离工作区的测试 URL，定时规则在触发一次后暂停并删除；不向外部渠道发送通知。矩阵验证服务端入口，不代表 Web、桌面、移动端交互及外部聊天渠道都已逐一验收。

`REAL_AGENT_SUITE=quality` 是聚焦蒸馏质量的真实双智能体验证：A 自动归档业务事实及持久代码风格偏好，成员评论把预算从 7600 更新为 8100，同一实体更新后重新晋升，B 在新 issue 中通过共享记忆恢复新预算及其他约定；私聊新会话召回真实周报格式。此套件不主动写入记忆，避免把直接写入当成自动蒸馏的质量证据。先按仓库 README 部署 `deploy/memory-policy.json` 对应的 OpenViking 模板。

`REAL_AGENT_SUITE=benchmark` 扩大自动蒸馏评测：三组不同消息系统及中英文项目别名，先提取初始预算，再正式更新预算与晋升，B 各在三个独立新 issue 中召回更新后的事实及实际共享来源；同一 A 与成员的私聊偏好做三次新会话召回，另一个 B 检查隔离。默认计划 20 个真实任务、9 次事实查询、27 项事实。`REAL_AGENT_BENCHMARK_REPEATS` 可设为 1..5。覆盖不足仍以全部计划为分母，提取/交付/事实准确性分别记录。

本套件启用原生 OpenCode 请求观测，并在首个 B 查询发布最终评论后注入一次明确标记的受控 401，检验 `0004` 的确认交付恢复及重复提交。仅当评测已经核验答案、实际来源及原任务评论后才确认恢复；生产中需要成员作同样核验。合成故障不进入真实提供商失败计数，原始任务错误与恢复前状态保留。OV 侧原生请求观测需按 `deploy/observers/README.md` 配置。

其他套件设置 `REAL_AGENT_OBSERVE_PROVIDER=1` 时，也会加载 OpenCode 请求观测（`deploy/observers/opencode.mjs`），记录写入状态目录的 `opencode-provider-requests.jsonl`；这种情况下不注入受控故障。

`REAL_AGENT_SUITE=delivery` 独立验证交付恢复，不受共享检索是否可用影响。成员直接提供一条待交付 JSON，实际智能体发布后才注入受控失败，核验内容，再两次提交同一恢复凭据，并确认仍只有一个任务且评论数量不增加。这里的答案由成员提供，不计入蒸馏准确性。

```bash
MULTICA_RUN_REAL_AGENT_SMOKE=1 REAL_AGENT_SUITE=benchmark \
  AGENT_MODEL=openrouter/openai/gpt-5.4-mini node e2e/real-agent/run.mjs
```

所有套件的记忆审计包含 `memories/` 及 `peers/*/memories/`，排除原生 identity/soul 和目录摘要；读取失败或到达遍历上限会标记不完整。已知执行控制、检索结果误写为实体、平台脚手架另列为 `qualityFindings`；该规则检查不能证明没有其他语义污染。`exactDuplicates` 列出原始文件的完全相同内容，原生所有者与 peer 副本保留出处。

使用已迁移的本地开发 Multica（默认 API `http://127.0.0.1:18080`、开发验证码 `888888`）、真实 OpenViking 0.4.22、已安装且在 PATH 中的 OpenCode 1.17.7。Multica 需依序应用 `upstream/multica/` 的三个运行上下文补丁；benchmark 另需 `0004` 交付恢复补丁。CLI 用官方构建规则生成版本号；浅克隆需先取得 release tags，不能以固定的旧版本号构建，否则快速创建会被版本门禁拒绝。模型默认 `openrouter/z-ai/glm-5.3-flash`，通过现有 `OPENROUTER_API_KEY` 环境变量使用；配置文件仅保存环境变量引用。

```bash
# 先由本地服务管理工具释放 PLUGIN_URL 所用端口；测试结束后恢复原服务。
# 密钥从当前授权环境注入，不放在命令行或仓库中。
export MC_CLI=/path/to/multica
export MC_BASE=http://127.0.0.1:18080
export OV_BASE=http://127.0.0.1:1936
export PLUGIN_URL=https://127.0.0.1:8790
export OVMEM_TLS_CERT=/path/to/plugin.pem
export OVMEM_TLS_KEY=/path/to/plugin.key
export NODE_EXTRA_CA_CERTS=/path/to/ca-bundle.pem
export REPORT_FILE=/tmp/real-agent-report.json
MULTICA_RUN_REAL_AGENT_SMOKE=1 node e2e/real-agent/run.mjs
# 完整矩阵；AGENT_MODEL 可选择当前连接中已确认可用的模型。
MULTICA_RUN_REAL_AGENT_SMOKE=1 REAL_AGENT_SUITE=matrix node e2e/real-agent/run.mjs
```

这是实际模型执行，会使用已配置账号的额度；只有用户明确授权时设置 `MULTICA_RUN_REAL_AGENT_SMOKE=1`。OpenViking 根凭据使用 `OV_ROOT_KEY`，OpenRouter 使用 `OPENROUTER_API_KEY`。主机用户目录需要允许创建专用 Multica profile；只读主机可用正常的执行环境文件权限授权。不要改写 `HOME` 或复用现有 profile。OpenCode 的 XDG 数据、配置、缓存、状态目录应由执行环境配置到可写目录。

每次测试创建独立工作区、一天有效的测试 PAT、独立 profile 和临时状态目录。daemon 与测试插件在 `finally` 中停止；测试数据及私有配置保留供排查，报告不包含凭据。脚本不会停止原有插件或自动恢复它，端口释放和原服务恢复由调用方负责。

`REAL_AGENT_STATE_POINTER` 可指定本地状态目录指针文件；`AGENT_MODEL` 可选择其他已授权的 OpenRouter 模型。检查结果和详细转写位于脚本打印的状态目录中。

仅对在快速创建版本检查处停止、尚未执行该任务的矩阵，可设置 `REAL_AGENT_RESUME_STATE` 为原状态目录继续。脚本复用原隔离工作区、成员、profile 与两名智能体，轮换该测试安装的凭据并保留先前停止原因，不重新提供业务答案。

若原矩阵已经完成前三种自动化的调度，收尾诊断可同时设置 `REAL_AGENT_MATRIX_PHASE=finish`：复测快速创建，按平台保存的 webhook run ID 与自动化创建的 issue ID 核对真实任务，再执行并发、共享晋升和归档审计。原失败记录保留在 `results`；`currentResults` 对每个检查取最新结果，明确表示修复后的状态。

若矩阵在旧版共享晋升抽取失败后停止，可用 `REAL_AGENT_MATRIX_PHASE=shared` 重放已失败的原始共享归档，核验队列重驱完成，再让 B 从实际共享记忆召回答案并审计全部样例。保留原模型错误和恢复事件，不重给业务数值。

质量套件在 B 的共享查询遭遇模型错误后，可用 `REAL_AGENT_RESUME_STATE` 指定原状态目录并设置 `REAL_AGENT_QUALITY_PHASE=continue`：沿用原工作区、智能体与记忆，更新该测试工作区的 skill；未观察到有效召回时，在新 issue 中重发原问题，避免 runtime 重跑会话只复述旧答案。已观察到有效召回则保留它，并独立检查最终任务状态，再完成私聊与审计。原失败转写、检查和模型保持不变，查询不重新提供业务答案。`currentResults` 表示按检查 ID 取最新验证，不能把有恢复的执行称为一次全部通过。

benchmark 在服务错误后可设置 `REAL_AGENT_RESUME_STATE` 为原目录及 `REAL_AGENT_BENCHMARK_PHASE=continue`，沿用原成员、A/B 与语料，补齐尚未执行的查询和更新。已执行的查询不重新给答案或替换得分，原失败和阶段异常保留。抽取失败单独记录，后续独立查询继续执行；它们可能没有可用语料，报告应同时查看准备阶段错误与召回结果。
