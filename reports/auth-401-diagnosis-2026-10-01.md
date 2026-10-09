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

`hardening-123-2026-10-01` 中"SDK 边界缺认证头 0 次"的依据是 `authorization_present`，它只要认证头非空就为真。所以单看这份数据，排除不了"客户端发出了空密钥"。

> 本节最初据此推断"更可能是出错进程拿到的 `OPENROUTER_API_KEY` 为空"。这个推断已被下文"后续复核"推翻，以后续复核为准。

## 改动

- 模型请求观测（OpenCode 插件、OV 的 HTTPX 包装）和插件自身的 HTTP 诊断，新增 `authorization_scheme` 与 `authorization_token_present` 两个字段，仍不记录认证值。
- 失败诊断新增 `provider_auth_reason`，取值为 `no_bearer_token`、`missing_authorization` 或 `unknown_api_key`，只在 401 时归类。（第一版叫 `empty_bearer_token`，后续复核发现 `Basic` 认证也会得到同样的文本，因此改名。）
- 回归：Node 137/137，Python 观测测试 4/4。新增测试在改动前的代码上会失败（Node 4 个、Python 2 个）。

## 同期发现

OV 0.4.22 偶发会话提交卡在 `pending`，日志为 `SessionCommit: Expecting value: line 1 column 1`。这条消息会停留在 processing 状态，直到 OV 重启时由 RecoverStale 重新入队，重启后已验证恢复并写出 `.done`。插件对此要等满 `extractMaxWatchMs`（默认 6 小时）才标为 `timeout`，并且不会重驱。本轮约 40 次提交中出现 1 次。

## 后续复核（同日，真实密钥运行之后）

真实密钥下的运行见 [real-agent-2026-10-01-openrouter.md](real-agent-2026-10-01-openrouter.md)：688 次带认证的请求，没有一次 401。复核旧证据时又发现三点。

**1. "缺少认证"的文本范围更宽。** 对线上接口补测了几种头部形态：

| OpenRouter 收到的认证头 | 结果 |
| --- | --- |
| `Basic` 认证 | 401 `Missing Authentication header` |
| `Bearer` 后只有空白 | 401 `Missing Authentication header` |
| `Token <key>`，或只有 `x-api-key` | 401 `User not found.` |
| 同一请求里出现两个认证头 | Cloudflare 400 Bad Request |

所以 `Missing Authentication header` 的准确含义是：认证头里没有可用的 Bearer token。它不一定意味着 SDK 发出了空密钥。

**2. 旧观测器会在 token 为空时丢掉请求 ID。** 它把 `Bearer ` 拆出的空字符串当作需要避开的"秘密"，而空字符串是任何字符串的子串，于是 cf-ray 等响应 ID 被全部丢弃。`hardening-123` 里 3 个 OV 401 样本（embeddings）都保留了 cf-ray，说明这 3 次请求在 HTTPX 边界发出的 token 不为空。另外，openai SDK 2.54 在构造客户端时就会拒绝空密钥。

**3. 结论需要调整。** OV 这边的证据指向：token 离开 SDK 时不为空。如果这些 401 的文本是 `Missing Authentication header`，那么认证头是在 SDK 之后被清空、改写成非 Bearer 形式，或被替换的。原环境里有一层做 TLS 重新终止的代理，并配置了自定义证书信任，是首要排查对象。

但旧观测不记录每次 401 的文本，这 3 个样本也可能是 `User not found.`（key 不对），所以还不能下定论。OpenCode 的观测器先按 WHATWG 规则规范化认证头，这条请求 ID 的推断对它不适用。不过同一进程里先成功、后 401，同样不像是"进程本身拿到了空密钥"。

本次修复：
- 观测器在 token 为空时保留请求 ID；
- 观测范围扩展到 OV 走 `requests` 库的重排调用；
- 原因码 `empty_bearer_token` 改名为 `no_bearer_token`。

下一步：在原出错环境部署新观测，对照同一请求的 `authorization_token_present`、`provider_auth_reason` 和 cf-ray，必要时把 cf-ray 交给 OpenRouter 支持核对。
