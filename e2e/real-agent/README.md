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

使用已迁移的本地开发 Multica（默认 API `http://127.0.0.1:18080`、开发验证码 `888888`）、真实 OpenViking 0.4.22、已安装且在 PATH 中的 OpenCode 1.17.7。Multica 需依序应用 `upstream/multica/` 的三个补丁。CLI 用官方构建规则生成版本号；浅克隆需先取得 release tags，不能以固定的旧版本号构建，否则快速创建会被版本门禁拒绝。模型默认 `openrouter/z-ai/glm-5.3-flash`，通过现有 `OPENROUTER_API_KEY` 环境变量使用；配置文件仅保存环境变量引用。

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
