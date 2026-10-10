# 从空白 fork 部署

适用于：你 fork 了 [multica-ai/multica](https://github.com/multica-ai/multica) 和 OpenViking，要从零接入这个记忆插件。本文按顺序写明每一步在哪个仓库、改什么。README 的[接入指南](../README.md#接入指南)是精简版。

**这份流程实际走过一遍**（2026-10-09，单机）：

- Multica main `10a7e51` 加 5 个补丁，`make build` 构建，环境变量按下文第 1.3 节；
- PyPI 上原版的 OpenViking 0.4.22，root key 用环境变量注入；
- 内网方案，自建 CA 签发证书；模型用 mock；
- 用 `e2e/real-stack/run.mjs` 验证，13/13 通过。只靠 Multica 下发回调地址、插件侧不配 `OVMEM_MULTICA_API_URL` 时，读取运行转写、私聊归档、召回绑定同样通过。

Docker 自部署 Multica 的命令（第 1.4 节）按 Multica 仓库的 Makefile 和 compose 文件写成，没有实际跑过。

## 总览

| 仓库 | 要做什么 |
| --- | --- |
| Multica fork | 应用本仓库的 5 个补丁；打开插件系统；如果插件服务在内网，登记它的地址 |
| OpenViking fork | **不改代码**，只写配置并启动 |
| 本仓库 | 部署插件服务；打包插件并装进工作区 |

连线只有这几条：

```
                  钩子与工具调用（HTTPS，Multica 签名）
 Multica 服务端 ──────────────────────────────────▶ 插件服务 ──────▶ OpenViking
       ▲                                              │
       └──────────── 回调：读取运行详情（/v1）──────────┘
       ▲
       └── 智能体所在机器上的 daemon（只连 Multica）
```

OpenViking 只需要插件服务能访问，不要对外暴露。

## 1. Multica fork

### 1.1 把补丁作为提交放进 fork

```bash
git clone https://github.com/<you>/multica.git && cd multica
git remote add upstream https://github.com/multica-ai/multica.git
git fetch upstream --tags
git checkout -b plugins upstream/main          # 或你要部署的上游版本
git am <本仓库>/upstream/multica/0*.patch       # 按编号顺序应用 5 个补丁
git push -u origin plugins
```

跟进上游时，`git fetch upstream --tags && git rebase upstream/main`，然后重新构建，并跑一遍补丁自带的测试（命令见 [`upstream/multica/README.md`](../upstream/multica/README.md#应用构建与验证)）。补丁只改服务端，没有数据库迁移，daemon 和 CLI 不变。

### 1.2 构建

```bash
make build        # 生成 server/bin/server、server/bin/multica、server/bin/migrate
```

版本号取自 git tag，所以一定要先 `git fetch upstream --tags`。CLI 的版本号不对时，快速创建会被版本检查拒绝。

### 1.3 服务端环境变量

在 Multica 原有配置（`DATABASE_URL`、`JWT_SECRET` 等，见 Multica 的 `.env.example` 和 `SELF_HOSTING.md`）之外，插件需要：

| 变量 | 值 | 说明 |
| --- | --- | --- |
| `FF_PLUGINS_V1` | `on` | 插件系统默认关闭，不开就没有插件目录和安装入口 |
| `MULTICA_PLUGIN_SECRET_KEY` | `openssl rand -base64 32` 的输出 | 派生每个安装的签名密钥，并加密插件的密钥类配置。不配时插件仍能安装，但轮换 token 拿不到 `SigningSecret`，钩子也一律不发。生成后保持不变：换了它，所有安装的签名密钥都会变 |
| `MULTICA_PLUGIN_API_URL` | 插件服务能访问到的 Multica 地址加 `/v1`，如 `https://multica.example.com/v1` | 钩子请求里带给插件的回调地址。不配时用 `MULTICA_PUBLIC_URL` 加 `/v1`；两个都没配，钩子请求就不带回调地址（这时插件侧必须配 `OVMEM_MULTICA_API_URL`，见第 4 节） |
| `MULTICA_PLUGIN_DEV_ORIGINS` | 插件服务的确切地址，如 `https://ovmem.internal:8790` | 只在内网方案需要，见第 3 节。多个用逗号分隔 |
| `MULTICA_PLUGIN_DEV_CA` | 自建 CA 的 PEM 路径 | 只在内网方案、且证书由自建 CA 签发时需要 |

启动后，Multica 日志里出现 `Plugin secret encryption enabled` 说明密钥生效。如果有 `hook callbacks will carry no callback_url` 的警告，说明 `MULTICA_PLUGIN_API_URL` 和 `MULTICA_PUBLIC_URL` 都没配。

### 1.4 用 Docker 自部署时

官方镜像没有补丁，要从 fork 构建镜像。另外，Multica 的 `docker-compose.selfhost.yml` 只把列出的变量传进 backend 容器：`MULTICA_PLUGIN_SECRET_KEY`、`MULTICA_PLUGIN_API_URL` 在列表里，写进 `.env` 即可；`FF_PLUGINS_V1` 和 `MULTICA_PLUGIN_DEV_*` 不在，要另加一个 compose 文件：

```yaml
# docker-compose.plugins.yml（放在 Multica fork 根目录）
services:
  backend:
    environment:
      FF_PLUGINS_V1: "on"
      # 以下两项只在内网方案需要
      MULTICA_PLUGIN_DEV_ORIGINS: https://ovmem.internal:8790
      MULTICA_PLUGIN_DEV_CA: /certs/plugin-dev-ca.pem
    volumes:
      - ./plugin-certs/plugin-dev-ca.pem:/certs/plugin-dev-ca.pem:ro
```

```bash
docker compose -f docker-compose.selfhost.yml -f docker-compose.selfhost.build.yml \
  -f docker-compose.plugins.yml up -d --build
```

前两个文件就是 Multica 的 `make selfhost-build` 用的组合；第一次部署可以先跑一次 `make selfhost-build` 生成 `.env`。

## 2. OpenViking fork

插件不需要 OpenViking 有任何改动，fork 保持上游原样即可。版本要 ≥ 0.4.22；我们验证用的是 PyPI 上的 `openviking==0.4.22`。用 fork 时，按 OpenViking 自己的方式从 fork 安装同一版本或更新的代码。

1. **配置**：复制本仓库的 [`deploy/ov.openrouter.conf.example`](../deploy/ov.openrouter.conf.example)。
   - root key 和模型 key 写成 `${OV_ROOT_KEY}`、`${OPENROUTER_API_KEY}`，由 OpenViking 启动时从环境变量读取，不落在文件里；
   - 按需改 `storage.workspace`（数据目录）和 `server.port`（默认 1933）；
   - 模型选型和已知限制见 README 接入指南第 1 步。
2. **启动**：

   ```bash
   OV_ROOT_KEY=<openssl rand -hex 32 生成> OPENROUTER_API_KEY=<…> \
     openviking-server --config ov.conf
   ```

3. **检查**：`curl http://<ov 地址>:1933/health` 返回 `"healthy":true`、`"version":"0.4.22"`、`"auth_mode":"api_key"`。

root key 只交给插件服务（`OVMEM_OV_ROOT_KEY`），插件只用它给每个工作区开通账号和空间。

想先不花钱试通：用 `e2e/real-stack/ov.conf.example` 和 `e2e/real-stack/mock-llm.mjs` 代替真实模型，见第 6 节。

## 3. 插件服务的网络与证书

Multica 默认只调用公网 HTTPS 地址的钩子：域名必须解析到公网 IP，证书必须由公共 CA 签发。解析到 `localhost`、10.x、172.16–31.x、192.168.x、100.64.x（如 Tailscale）或 Docker 宿主机地址的钩子会被拒绝。按插件服务放在哪里，二选一：

| | 公网 | 内网（与 Multica 在同一网络） |
| --- | --- | --- |
| 钩子地址 | `https://hooks.example.com` | `https://ovmem.internal:8790` |
| 证书 | 公共 CA 签发 | 自建 CA：`./deploy/dev-certs.sh <ca 目录> deploy/certs ovmem.internal` |
| Multica 配置 | 无 | `MULTICA_PLUGIN_DEV_ORIGINS` 写这个地址；用自建 CA 时 `MULTICA_PLUGIN_DEV_CA` 指向 `<ca 目录>/plugin-dev-ca.pem` |

内网方案的几点说明：

- `MULTICA_PLUGIN_DEV_ORIGINS` 是 Multica 访问内网钩子的唯一办法。名字里有 DEV，但不受 `APP_ENV` 限制，生产环境同样生效。
- 地址要完整写出 `https://主机:端口`，和打包时的 `--url` 完全一致。
- 配了 `MULTICA_PLUGIN_DEV_CA` 后，这些地址只信任这一个 CA。
- `dev-certs.sh` 在 CA 目录为空时会新建 CA；签出的证书包含给定主机名、`localhost` 和 `127.0.0.1`。

两种方案下，`net:` scope 都照样生效：Multica 只调用安装时授权过的主机。

## 4. 部署插件服务并安装

按 README 接入指南的第 3–8 步做，这个场景下的取值：

1. **配置** `deploy/.env`：
   - `OVMEM_OV_BASE_URL`：插件服务能访问到的 OpenViking 地址；
   - `OVMEM_OV_ROOT_KEY`：和 OpenViking 的 `OV_ROOT_KEY` 相同；
   - `OVMEM_MULTICA_API_URL`（推荐）：插件服务能访问到的 Multica 地址加 `/v1`。配了它，插件不依赖 Multica 下发的回调地址，新安装也会先经 `GET /v1/context` 核实工作区再绑定；
   - `OVMEM_TLS_CERT` / `OVMEM_TLS_KEY`：第 3 节的证书，放进 `deploy/certs/` 后在容器里是 `/certs/…`；
   - `OVMEM_PLUGIN_TOKEN`：随机长字符串。
2. **打包**：`bash scripts/package.sh --url https://ovmem.internal:8790 --with-chats-read`（公网方案换成公网地址）。
3. **安装**：在 Multica 工作区 Settings → Plugins 上传 zip，授权 scope。
4. **启动**：轮换插件 token，把 `SigningSecret` 填进 `OVMEM_SIGNING_SECRET`，然后 `docker compose -f deploy/docker-compose.yml up -d --build`。
5. **绑定 skill**，配置 `memory_rules`。
6. **验证**：按 README 接入指南第 8 步。

## 5. 智能体运行环境

- **daemon 和 CLI**：补丁不改它们，用上游发布的版本或从 fork 构建的都可以；从 fork 构建时注意第 1.2 节的版本号。
- **运行时**：真实验证用的是 OpenCode 1.17.7，全部工具可用。kimi 等 ACP 运行时、pi 的限制见 README“智能体拿到的工具”。

## 6. 本地演练（不花钱）

在一台机器上把第 1–4 节走一遍，模型用 mock。我们按下面的方式验证本文：

1. PostgreSQL 建一个空库，`server/bin/migrate up`；
2. 按第 1.1–1.3 节构建并启动 Multica fork。本地开发再加 `APP_ENV=development`、`MULTICA_DEV_VERIFICATION_CODE=888888`，内网方案的地址用 `https://host.docker.internal:8790`，并在 `/etc/hosts` 把 `host.docker.internal` 指向 `127.0.0.1`；
3. `./deploy/dev-certs.sh <ca 目录> <证书目录>` 新建 CA 并签发证书；
4. 启动 `node e2e/real-stack/mock-llm.mjs`，用 `e2e/real-stack/ov.conf.example` 启动 OpenViking；
5. 跑 `e2e/real-stack/run.mjs`（用法见 [`e2e/real-stack/README.md`](../e2e/real-stack/README.md)）。脚本自己建工作区、安装插件、轮换密钥、启动插件服务，逐项输出 PASS/FAIL。

13 项都通过，说明 Multica 的插件配置、网络与证书、补丁、OpenViking 配置都对了。之后换上真实模型的配置，就可以按第 4 节正式部署。

## 7. 升级与维护

- **Multica**：按第 1.1 节 rebase fork，重新构建，跑补丁测试。补丁冲突的处理见 [`upstream/multica/README.md`](../upstream/multica/README.md#维护方式)。
- **OpenViking**：生产环境从 0.4.21 升到 0.4.22 还没有演练过。向量模型和维度选定后不要换，换了要重建全部向量索引。
- **插件**：用新版本重新打包，在各工作区更新；插件服务换成新版本后重启。从 0.2.x 升级见 README 的“从 0.2.x 升级”。
