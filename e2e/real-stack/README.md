# 真实栈端到端（真实 multica + 真实 OpenViking）

`run.mjs` 验证真实 multica 服务端（补丁版或 stock 版）、真实 OpenViking 和本插件之间的协议。运行转写与工具请求使用场景样例，通过 daemon API 提交；multica 的签名、事件投递、重试、熔断和 OpenViking 的抽取、检索均实际执行。该脚本不启动智能体 CLI；真实智能体执行见 [`../real-agent/`](../real-agent/README.md)。

脚本会：创建两个工作区 → 在两边安装插件包并轮换密钥 → 用轮换得到的签名密钥启动插件服务 → 逐个场景执行，输出 PASS/FAIL。

multica 的版本是**探测**出来的：带 `chats:read` 的包被接受，说明打了 `upstream/multica` 补丁；被拒绝则是 stock 版，改用默认包。

## 场景

| 步骤 | 补丁版 multica | stock multica |
| --- | --- | --- |
| S0 | 两个工作区各自发布、安装、轮换密钥 | 同左 |
| R1 | 成员评论 → `comment.created` → 以人类反馈归档 → 抽取 → 可检索 | 同左 |
| R2a | 运行内 `memory-recall` **绑定到调用它的运行**，命中该 issue 的协作记忆 | 智能体指定 issue 时命中（报告为未绑定） |
| R2b | `memory-remember` 写入本智能体公共记忆，重复写入幂等 | 同左 |
| R2b-recall | 后台索引后，通过运行内 `memory-recall` 召回同一 URI 和五维模板原文 | 同左 |
| R2c | `task.completed` → 从任务 API 读转写 → 完整归档 → 抽取 → 可检索 | 无任务 API：以 200 跳过，不产生噪音归档、不计入熔断 |
| R2d | 收尾评论原文已被完整持久化的运行归档覆盖时，不重复归档 | 收尾评论作为智能体陈述归档，代表这次运行 |
| R3a | 连续 6 次私聊运行后，`memory-archive` 仍在接收事件（熔断未打开） | 同左 |
| R3b | 私聊原话按 peer_id 归档；中文注释和驼峰命名偏好可召回，别处没有 | 以 200 跳过，不落进任何 issue 空间 |
| R4 | `ov-*` 门面：共享命名空间、他人空间被拒，自己空间可用 | 同左 |
| R5 | 召回绑定运行：模型点名的其他 issue 不被检索 | 无法得知调用方运行，报告为未绑定（已知限制） |
| R6 | 租户隔离：工作区 2 看不到工作区 1；其密钥无法触达工作区 1；安装 2 经 `GET /v1/context` 绑定 | 同左 |
| R7 | LLM 失败 → 抽取失败 → 在新会话（`-r1`）重驱 → 抽取成功（需 `MOCK_LLM_URL`） | 同左 |

使用真实模型时，R1 同时核验告警阈值 1 万条，R2c 核验 RocketMQ、预算 3800 元和双写两周，R3b 核验两项偏好。设置 `MOCK_LLM_URL` 时，这三步仅验收管道和范围；R2b-recall 在两种模式下均核验主动写入原文。

## 前置条件

1. **PostgreSQL** + 已迁移的 multica 数据库。
2. **multica 服务端**（`server/bin/server`），环境变量至少包含：

   ```bash
   APP_ENV=development
   MULTICA_DEV_VERIFICATION_CODE=888888
   FF_PLUGINS_V1=on
   MULTICA_PLUGIN_SECRET_KEY=<随机 32 字节>
   MULTICA_PLUGIN_DEV_ORIGINS=https://host.docker.internal:8790
   MULTICA_PLUGIN_DEV_CA=<dev CA 证书路径>
   ```

   要测补丁版，先 `git am upstream/multica/0001-*.patch` 再构建；stock 版直接构建。
3. **插件的 HTTPS 证书**：multica 只调 HTTPS 钩子。用 dev CA 签一张 `host.docker.internal` 证书：`./deploy/dev-certs.sh <ca-dir> <out-dir>`；并让 `host.docker.internal` 解析到本机（`/etc/hosts`）。
4. **OpenViking ≥ 0.4.22**。离线跑可以用本目录的 `mock-llm.mjs` 充当模型提供方（确定性 embedding + schema 形状的抽取输出，OV 自身代码路径全部真实）：

   ```bash
   node e2e/real-stack/mock-llm.mjs &                 # 127.0.0.1:18999
   cp e2e/real-stack/ov.conf.example ov.conf          # 填 root_api_key 和存储路径
   openviking-server --config ov.conf                 # 127.0.0.1:1936
   ```

   mock 不会写出有意义的"记忆"，只保证抽取管道真实运转；验证蒸馏质量请接真实模型。

## 运行

```bash
OV_ROOT_KEY=<ov root key> \
OVMEM_TLS_CERT=<out-dir>/hook-server.pem OVMEM_TLS_KEY=<out-dir>/hook-server.key \
PLUGIN_CA=<ca-dir>/plugin-dev-ca.pem \
MOCK_LLM_URL=http://127.0.0.1:18999 \
REPORT_FILE=reports/real-stack.json \
node e2e/real-stack/run.mjs
```

其余可选变量：`MC_BASE`（默认 `http://127.0.0.1:8080`）、`OV_BASE`（默认 `http://127.0.0.1:1936`）、`PLUGIN_URL`（默认 `https://host.docker.internal:8790`，必须在 `MULTICA_PLUGIN_DEV_ORIGINS` 里）、`MC_DEV_CODE`。

插件由脚本自己启动（端口取自 `PLUGIN_URL`），状态目录是临时目录；抽取监视与重驱间隔通过 `state/config.json` 调快，代码路径与生产一致。每次运行都新建工作区，可重复执行。
