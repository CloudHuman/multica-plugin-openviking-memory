# 端到端验证

`run-e2e.mjs` 用**真实 OpenViking 实例**（真实 LLM 抽取 + 语义检索）驱动插件全链路，multica 侧用契约兼容的模拟端（签名投递 + callback API）。

## 覆盖的场景

| 步骤 | 验证内容 |
| --- | --- |
| S0 | 插件服务启动，OV 健康上报 |
| S1 | task.completed → 归档 → **真实抽取** → 语义检索命中 |
| S2 | 蒸馏产物携带业务结论（无运行时简报、无探针工具噪音） |
| S3 | 智能体 `memory-recall` 工具：范围化返回 + 来源 |
| S4 | `memory-remember` 写入本智能体公共空间，其他智能体空间未开通 |
| S5 | comment.created → 人类反馈归档（作者归属）并蒸馏 |
| S6 | companion 私聊事件 → 配对空间归档并蒸馏 |
| S7 | **跨空间读取被 OV 拒绝**（结构化隔离） |
| S8 | 智能体 B 的召回不含智能体 A 的公共记忆 |
| S9 | 重复投递被账本去重 |
| S10/S11 | memory-status / admin status |

## 运行

需要一个 OV 实例的 LLM/embedding 密钥（从现有实例提取，或使用你自己的）：

```bash
export OV_VLM_KEY=$(docker exec <ov-container> cat /app/.openviking/ov.conf \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).vlm.api_key))")
export OV_EMBED_KEY=$(docker exec <ov-container> cat /app/.openviking/ov.conf \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).embedding.dense.api_key))")

node e2e/run-e2e.mjs
```

脚本会自动：拉起一次性 OV v0.4.22 容器（`ovmem-e2e-ov`，127.0.0.1:1936，内嵌存储）、启动插件服务、跑全部场景并输出 PASS/FAIL 汇总。密钥只经环境变量注入，不落盘。

清理：`docker rm -f ovmem-e2e-ov && docker volume rm ovmem-e2e-ov-data`
