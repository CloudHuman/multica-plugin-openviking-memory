# 端到端验证

两套端到端：

| 脚本 | multica 侧 | OpenViking | 用途 |
| --- | --- | --- | --- |
| `run-e2e.mjs` | 契约兼容的模拟端（签名投递 + callback API） | **真实实例** | 快速验证插件 ↔ OV 全链路，含真实抽取与语义检索 |
| `real-stack/run.mjs` | **真实 multica 服务端**（补丁版 / stock 版） | **真实实例** | 验证插件在真实部署里的行为，见 [`real-stack/README.md`](real-stack/README.md) |

## run-e2e.mjs 覆盖的场景

模拟端有两种契约：`E2E_MULTICA=patched`（默认，带任务读取 API，见 `upstream/multica/`）和 `E2E_MULTICA=stock`（v0.6 原版，无任务 API）。

| 步骤 | 验证内容 |
| --- | --- |
| S0 | 插件服务启动，OV 健康上报 |
| S1 | patched：`task.completed` → 读转写 → 归档 → **真实抽取** → 语义检索命中；stock：运行事件以 200 跳过（S1a），运行的收尾评论归档后命中 |
| S2 | 蒸馏产物携带业务结论（无运行时简报、无探针工具噪音），从第 0 行读取 |
| S3 | `memory-recall`：范围化返回 + 来源（patched 绑定到调用它的运行） |
| S4 | `memory-remember` 写入本智能体公共空间，其他智能体空间未开通 |
| S5 | `comment.created`（真实评论结构）→ 人类反馈归档（作者归属）并蒸馏 |
| S6 | 配套 API 私聊事件 → 配对空间归档并蒸馏 |
| S7 | **跨空间读取被 OV 拒绝**（结构化隔离） |
| S8 | 智能体 B 的召回不含智能体 A 的公共记忆 |
| S9 | multica 以新 invocation_id 重投、或原样重投，都是 `duplicate` |
| S10 | `memory-status`：健康、队列、每条归档的抽取状态（等抽取监视全部落定） |
| S11 | admin status |
| S12 | `ov-*` 门面经真实 OV `/mcp` 工作，且拒绝共享命名空间与他人空间的 URI |

## 运行

已有 OV 实例（默认 `127.0.0.1:1936`）时直接复用，只需 root key：

```bash
OV_ROOT_KEY=<root key> node e2e/run-e2e.mjs                       # patched 契约
OV_ROOT_KEY=<root key> E2E_MULTICA=stock node e2e/run-e2e.mjs     # stock 契约
```

没有实例时，脚本会拉起一次性 OV v0.4.22 容器（`ovmem-e2e-ov`，127.0.0.1:1936，内嵌存储），此时需要模型密钥（从现有实例提取，或使用你自己的）：

```bash
export OV_VLM_KEY=$(docker exec <ov-container> cat /app/.openviking/ov.conf \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).vlm.api_key))")
export OV_EMBED_KEY=$(docker exec <ov-container> cat /app/.openviking/ov.conf \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).embedding.dense.api_key))")

node e2e/run-e2e.mjs
```

密钥只经环境变量注入，不落盘。离线环境可用 `real-stack/mock-llm.mjs` + `real-stack/ov.conf.example` 起一个模型提供方为 mock 的 OV。

清理：`docker rm -f ovmem-e2e-ov && docker volume rm ovmem-e2e-ov-data`
