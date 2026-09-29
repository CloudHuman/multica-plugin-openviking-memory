import { OvMcpClient } from './ov-mcp.mjs';
import { scopeKey } from './scopes.mjs';

/**
 * The ov-* facade: one agent-trigger hook per native OpenViking MCP tool.
 *
 * Identity comes from the SIGNED hook body (actor.type=agent, actor.id —
 * injected by the multica server from the task row; the daemon cannot forge
 * it). The facade resolves THAT agent's public-memory space key and forwards
 * the call to OV /mcp verbatim, so every tool keeps its native semantics
 * while being structurally confined to the caller's own space (key=identity).
 *
 * Cross-scope recall (task collaboration / shared / DM memories) stays on
 * memory-recall; these tools are the full native surface for the agent's own
 * public space.
 */
export function makeOvToolHandler({ cfg, ov, registry }) {
  return async function ovTool(body) {
    const actor = body.actor ?? {};
    if (actor.type !== 'agent' || !actor.id) {
      throw new Error(`this tool is only callable by an agent (got actor type ${actor.type || 'none'})`);
    }
    const input = body.input ?? {};
    // hook keys use kebab-case; OV tool names are snake_case
    const toolName = String(body.hook_key ?? '').replace(/^ov-/, '').replace(/-/g, '_');
    if (!/^[a-z_]+$/.test(toolName)) throw new Error(`invalid facade tool ${toolName}`);

    const ws = body.workspace_id;
    const key = scopeKey('agent', ws, actor.id);
    const rec = await registry.ensureScope(key, { workspaceId: ws });
    const client = new OvMcpClient({ baseUrl: cfg.ovBaseUrl, key: rec.apiKey, timeoutMs: cfg.ovTimeoutMs });

    // Strip null/undefined args — MCP schemas often reject explicit nulls.
    const args = {};
    for (const [k, v] of Object.entries(input)) {
      if (v !== null && v !== undefined) args[k] = v;
    }
    const text = await client.callTool(toolName, args);
    return {
      tool: toolName,
      scope: key,
      note: '结果来自你自己的公共记忆空间(OpenViking 原生工具语义);跨任务协作/工作区共享记忆请用 memory-recall。',
      output: text,
    };
  };
}
