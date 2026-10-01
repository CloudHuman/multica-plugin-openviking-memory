# OpenRouter 401 归因复核 — 2026-10-01

结论：此前报告中的 `Missing Authentication header`，意思是 OpenRouter 收到了 `Bearer` 加空 token，不是认证头在链路上丢失。此前的观测只记录认证头是否非空，`Bearer ` 加空 token 也会被记为"存在"，因此区分不了这两种情况。本轮复核不依赖真实密钥；真实密钥下的复测另行记录。

## 401 文本对照

对 OpenRouter 线上接口逐项发送不带有效凭据的请求。`/api/v1/embeddings`、`/api/v1/chat/completions`、`/api/v1/rerank` 三个接口结果一致：

| OpenRouter 收到的认证头 | HTTP | 返回文本 |
| --- | --- | --- |
| 没有认证头 | 401 | `No cookie auth credentials found` |
| 认证头为空 | 401 | `No cookie auth credentials found` |
| `Bearer`，后面没有 token | 401 | `Missing Authentication header` |
| `Bearer ` 加空格 | 401 | `Missing Authentication header` |
| `Bearer` / `bearer` 加不存在的 key | 401 | `User not found.` |

## 链路复核（本地复现，不使用真实密钥）

| 环节 | 方法 | 结果 |
| --- | --- | --- |
| 出口代理（TLS 重新终止） | 使用假 token。Python openai 2.54 / httpx 0.28：连接池，顺序与 8 路并发，流式与非流式，共 360 次。Node fetch（undici，经 `HTTPS_PROXY`）：共 240 次 | 600/600 返回 `User not found.`，token 每次都完整到达 |
| OpenViking 0.4.22 | 在模型提供方前加一层转发，只记录认证头形态；OV 配置非空假密钥；运行 run-e2e（patched 13/13、stock 14/14）和 real-stack（patched 13/13），覆盖多工作区、抽取、检索、门面与重驱 | 474/474 次（embeddings 386、chat 88）都带着配置的密钥 |
| OpenCode 1.17.7 | 官方 daemon（补丁版 multica）+ real-agent 同款 openrouter provider 配置（`{env:OPENROUTER_API_KEY}`），baseURL 指向记录层 | 4/4（标题生成 1 次、主循环 3 次）都带着密钥 |

## 对既有报告的更正

`hardening-123-2026-10-01` 中"SDK 边界缺认证头 0 次"的依据是 `authorization_present`，它只要认证头非空就为真。所以这份数据不能排除"客户端发出了空密钥"。结合上表，更可能的方向是：出错时段里，OV 或 OpenCode 进程拿到的 `OPENROUTER_API_KEY` 为空，例如容器重建、环境变量注入或凭据注入出了问题。需要用下面的新字段在真实密钥下确认。

## 改动

- 模型请求观测（OpenCode 插件、OV 的 HTTPX 包装）和插件自身的 HTTP 诊断，新增 `authorization_scheme` 与 `authorization_token_present` 两个字段，仍不记录认证值。
- 失败诊断新增 `provider_auth_reason`，取值为 `empty_bearer_token`、`missing_authorization` 或 `unknown_api_key`，只在 401 时归类。
- 回归：Node 137/137，Python 观测测试 4/4。新增测试在改动前的代码上会失败（Node 4 个、Python 2 个）。

## 同期发现

OV 0.4.22 偶发会话提交卡在 `pending`，日志为 `SessionCommit: Expecting value: line 1 column 1`。这条消息会停留在 processing 状态，直到 OV 重启时由 RecoverStale 重新入队，重启后已验证恢复并写出 `.done`。插件对此要等满 `extractMaxWatchMs`（默认 6 小时）才标为 `timeout`，并且不会重驱。本轮约 40 次提交中出现 1 次。
