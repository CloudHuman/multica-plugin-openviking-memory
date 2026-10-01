# 原生模型请求观测

可选的诊断代码分别观察 OpenCode 的现有 provider fetch 与 OpenViking 原生 HTTPX SDK。两者都只观察 `openrouter.ai`，不改变凭据、模型、代理、证书验证或响应体，也不重试请求。默认关闭。

记录请求 UUID、时间、运行时、主机、路径（不含查询串）、方法、认证头是否存在、HTTP 状态、允许的响应请求 ID、耗时与重定向信息。日志没有认证值、请求体或模型响应。日志仅本机使用，以 0600 创建，超过 4 MiB 时保留一份 `.1` 轮转；已有文件的权限由部署者管理。日志写入失败不影响请求。

## OpenCode

保留原配置，在其 `plugin` 数组中增加 `file:///绝对仓库路径/deploy/observers/opencode.mjs`。该插件通过 `config` hook 包装 `provider.openrouter.options.fetch`；已有自定义 fetch 仍被调用。已在 OpenCode 1.17.7 的实际模型调用中验证。

```bash
export OVMEM_PROVIDER_DIAGNOSTICS=1
export OVMEM_PROVIDER_DIAGNOSTICS_FILE=/可写私有目录/opencode-provider-requests.jsonl
```

需要安装整个仓库或保留 `src/provider-observer.mjs`、`src/diagnostics.mjs` 的相对目录关系。此诊断插件只有默认导出；OpenCode 会把模块的函数导出当成插件加载。

## OpenViking

将此目录只读挂载进原生 OV 容器，例如 `/opt/ovmem-observers`，保留现有镜像、状态卷、配置、凭据与信任设置。启动容器的 Python 进程时，将此目录追加到既有 `PYTHONPATH`（保留其原值），并设置：

```bash
OVMEM_PROVIDER_DIAGNOSTICS=1
OVMEM_PROVIDER_DIAGNOSTICS_FILE=/app/.openviking/provider-requests.jsonl
```

Python 的 `sitecustomize.py` 在启用时安装同步及异步 HTTPX `send` 包装。日志目录须可写；这不需要替换 OpenViking 或其模型 SDK。使用当前配置的容器管理方式重启服务以生效。关闭环境开关或撤销挂载即可停用。

用 OV 原生 Python 环境运行 `scripts/test-provider-observers.py`，验证同步/异步请求、401 流式响应、日志错误与凭据脱敏。

## 如何解释 401

`authorization_present: true` 只表示认证头非空：`Bearer` 后面没有 token 也算存在。所以同时记录 `authorization_scheme`（`bearer` / `basic` / `other`）和 `authorization_token_present`，仍不记录值。它们描述 SDK 边界发出的内容，不能证明中间代理或网关最终收到相同认证内容，也不验证密钥有效性。

OpenRouter 的 401 文本能说明它实际收到了什么（2026-10-01 对线上接口逐项复现，embeddings / chat/completions / rerank 一致）：

| OpenRouter 收到的认证头 | 401 文本 | 诊断里的 `provider_auth_reason` |
| --- | --- | --- |
| `Bearer` + 空 token | `Missing Authentication header` | `empty_bearer_token` |
| 没有认证头，或头为空 | `No cookie auth credentials found` | `missing_authorization` |
| `Bearer` + 不存在的 key | `User not found.` | `unknown_api_key` |

`Missing Authentication header` 的含义是认证头到了 OpenRouter，但 token 为空。所以应先查发请求的进程当时拿到的密钥是否为空（环境变量、配置展开、凭据注入），而不是先查网络是否丢头。插件把这三种文本归入队列、抽取诊断的 `provider_auth_reason`。

配合失败请求的响应 ID、状态、主机和重定向记录排查。成功请求与失败请求应分别保留；不可用单次 200 证明间歇性 401 已解决。受控端到端故障单列为 `controlled-e2e-fault`，不会作为真实提供商 401 的证据。
