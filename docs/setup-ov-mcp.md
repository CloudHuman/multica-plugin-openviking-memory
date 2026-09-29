# 为智能体配置 OpenViking 原生 MCP 工具（16 个）

插件本身提供 3 个辅助工具（`memory-recall` / `memory-remember` / `memory-status`），随插件安装自动可用。OpenViking 原生的 16 个 MCP 工具（`find / search / read / list / tree / remember / write / edit / add_resource / add_skill / list_watches / cancel_watch / grep / glob / forget / health`）由 OV 的 `/mcp` 端点直接提供，需要维护者按智能体登记：

## 原则

- **一智能体一条 MCP 配置，嵌入该智能体公共空间的 OV key**——智能体只能通过自己的 key 访问自己的公共记忆空间；工作区共享/任务协作内容通过插件的召回与归档链路流动，不通过这条直连通道。
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

3. 验证：给智能体派一个任务，问它"调用 health 工具报告 OpenViking 版本"；或直接用 MCP 客户端连 `tools/list` 应返回 16 个工具。

## 与插件工具的分工

| 需求 | 用哪个 |
| --- | --- |
| 跨范围召回（任务协作+公共+共享，带来源） | 插件 `memory-recall` |
| 快速记一条可复用结论到公共记忆 | 插件 `memory-remember` 或原生 `remember` |
| 精确读/改/检索自己公共空间里的文件 | 原生 `read/write/edit/grep/glob/tree` |
| 向 OV 添加资料或 skill | 原生 `add_resource` / `add_skill` |
| 删除指定内容 | 原生 `forget`（不可逆，仅限自己空间） |
| 归档/抽取进度与服务状态 | 插件 `memory-status` |
