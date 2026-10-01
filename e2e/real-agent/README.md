# 真实智能体端到端测试

`run.mjs` 启动正式 Multica daemon，由实际 OpenCode CLI 和模型执行四个任务。脚本只创建工作区、安装插件、绑定 skill、分配任务与读取结果；转写和记忆工具调用均由真实智能体产生。

场景覆盖业务约定的主动记忆、自动归档与抽取、新任务召回四项原有约定并引用 URI、无答案时如实说明，以及专门读取平台 `AGENTS.md` 后的提示词过滤。检查直接读取 OpenViking 的归档和抽取文件。任何检查失败，脚本退出码为非零。

使用已迁移的本地开发 Multica（默认 API `http://127.0.0.1:18080`、开发验证码 `888888`）、真实 OpenViking 0.4.22、已安装且在 PATH 中的 OpenCode 1.17.7。Multica 需应用 `upstream/multica/` 的两个补丁。模型默认 `openrouter/z-ai/glm-5.3-flash`，通过现有 `OPENROUTER_API_KEY` 环境变量使用；配置文件仅保存环境变量引用。

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
```

这是实际模型执行，会使用已配置账号的额度；只有用户明确授权时设置 `MULTICA_RUN_REAL_AGENT_SMOKE=1`。OpenViking 根凭据使用 `OV_ROOT_KEY`，OpenRouter 使用 `OPENROUTER_API_KEY`。主机用户目录需要允许创建专用 Multica profile；只读主机可用正常的执行环境文件权限授权。不要改写 `HOME` 或复用现有 profile。OpenCode 的 XDG 数据、配置、缓存、状态目录应由执行环境配置到可写目录。

每次测试创建独立工作区、一天有效的测试 PAT、独立 profile 和临时状态目录。daemon 与测试插件在 `finally` 中停止；测试数据及私有配置保留供排查，报告不包含凭据。脚本不会停止原有插件或自动恢复它，端口释放和原服务恢复由调用方负责。

`REAL_AGENT_STATE_POINTER` 可指定本地状态目录指针文件；`AGENT_MODEL` 可选择其他已授权的 OpenRouter 模型。检查结果和详细转写位于脚本打印的状态目录中。
