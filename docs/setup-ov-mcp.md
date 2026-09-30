# 直连 OpenViking 原生 MCP（仅作运行时兜底）

插件安装后，工作区智能体自动获得 `memory-*` 工具和 15 个 `ov-*` 门面工具（OpenViking 原生工具经插件转发，`add_skill` 除外）。**优先使用插件门面**：门面把每个 URI 参数限制在调用者自己的空间（`viking://~/`），检索、列目录、添加资料默认落在那里。

本文描述的直连方式只用于**拿不到插件工具的运行时**（例如部分 ACP 运行时，见 README 的运行时差异）：给这类智能体登记一条直连 OV `/mcp` 的 MCP 服务。

> ⚠️ **直连绕过门面的空间限制。** 一个 multica 工作区对应一个 OpenViking 账号，账号内 `viking://resources`、`viking://agent` 是**所有用户共享**的命名空间。持有原始空间 key 的智能体可以读、写、删这些命名空间——包括其他智能体放在那里的资料。只有 `viking://user/<自己>` 下的记忆受存储层隔离。直连之前确认这个风险可以接受，并在该智能体的指令里要求只使用 `viking://~/`。

## 原则

- **一智能体一条 MCP 配置，嵌入该智能体公共空间的 OV key**——key 决定"你是谁"，但不限制账号共享的命名空间（见上方警告）；工作区共享/任务协作内容通过插件的召回与归档链路流动，不通过这条直连通道。
- key 保存在 multica 的 workspace MCP 配置里（服务端注入给任务，智能体进程内的 workdir 不落其他智能体的 key）。

## 步骤

1. 拿到智能体公共空间的 key。首次归档/remember 之后，插件的 `state/scopes.json` 里有：

   ```bash
   node -e "const s=require('./state/scopes.json'); \
     for (const [k,v] of Object.entries(s.scopes)) if (k.startsWith('agent:')) \
       console.log(k, v.apiKey)"
   ```

   也可以提前主动开通（对指定智能体调一次 `memory-remember` 工具，或用 `/admin/status` 查看）。

2. 在 multica 工作区的 MCP 服务配置中新增条目（名称建议 `openviking-<智能体名>`）：

   ```jsonc
   {
     "type": "http",
     "url": "https://<你的 OV 地址>/mcp",
     "headers": { "Authorization": "Bearer <该智能体公共空间的 key>" }
   }
   ```

   并在目标智能体上启用该 MCP 服务。

3. 验证：给智能体派一个任务，问它"调用 health 工具报告 OpenViking 版本"；或直接用 MCP 客户端连 `tools/list` 应返回 16 个工具（直连比门面多一个 `add_skill`，它默认写入账号共享的 `viking://agent/skills`）。

## 与插件工具的分工

| 需求 | 用哪个 |
| --- | --- |
| 跨范围召回（任务协作+公共+共享，带来源） | 插件 `memory-recall` |
| 快速记一条可复用结论到公共记忆 | 插件 `memory-remember` 或原生 `remember` |
| 精确读/改/检索自己公共空间里的文件 | 原生 `read/write/edit/grep/glob/tree` |
| 向 OV 添加资料 | 门面 `ov-add-resource`（默认存进自己的 `viking://~/resources`）；直连的 `add_resource` 默认写账号共享的 `viking://resources` |
| 添加 skill | 仅直连 `add_skill`（写入账号共享的 `viking://agent/skills`，门面不提供） |
| 删除指定内容 | 原生 `forget`（不可逆；经门面仅限自己空间，直连时共享命名空间也能删） |
| 归档/抽取进度与服务状态 | 插件 `memory-status` |
