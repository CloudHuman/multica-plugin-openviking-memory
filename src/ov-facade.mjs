import { OvMcpClient } from './ov-mcp.mjs';
import { scopeKey } from './scopes.mjs';

/**
 * The ov-* facade: one agent-trigger hook per native OpenViking MCP tool.
 *
 * Identity comes from the SIGNED hook body (actor.type=agent, actor.id —
 * injected by the multica server from the task row; the daemon cannot forge
 * it). The facade resolves THAT agent's public-memory space key and forwards
 * the call to OV /mcp, so every tool keeps its native semantics.
 *
 * A space key alone does not confine a tool call: inside one OV account,
 * viking://resources and viking://agent are shared by every user, and the
 * plugin maps a whole multica workspace to one account. So before forwarding,
 * every URI argument must lie in the caller's own user space (viking://~ or
 * viking://user/<own id>), searches default to that root, a context-mode
 * search is limited to memories (user-scoped by construction), and resources
 * are stored privately. That is what makes "仅限你自己的空间" true.
 *
 * Cross-scope recall (task collaboration / shared / DM memories) stays on
 * memory-recall.
 */
const SINGLE_URI_KEYS = ['uri', 'target_uri', 'to_uri', 'to', 'parent'];
const DEFAULT_ROOT = 'viking://~/';

export function confineToOwnSpace(toolName, input, ownUserId) {
  const args = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (v !== null && v !== undefined) args[k] = v;
  }
  const own = (uri) => isOwnUri(uri, ownUserId);

  // The browsing tools default to the namespace root (viking://); for this
  // facade the root is the caller's own space.
  if (['tree', 'glob', 'list'].includes(toolName) && (!args.uri || args.uri === 'viking://' || args.uri === 'viking:///')) {
    args.uri = DEFAULT_ROOT;
  }

  for (const key of SINGLE_URI_KEYS) {
    if (typeof args[key] === 'string' && args[key] !== '' && !own(args[key])) {
      return { error: `${key} "${args[key]}" is outside your own memory space; use viking://~/…` };
    }
  }
  // OV's read takes `uris` as one string or a list.
  if (args.uris !== undefined) {
    const outside = [].concat(args.uris).find((u) => !own(String(u)));
    if (outside !== undefined) return { error: `uri "${outside}" is outside your own memory space; use viking://~/…` };
  }
  if (typeof args.path === 'string' && args.path.startsWith('viking://') && !own(args.path)) {
    return { error: `path "${args.path}" is outside your own memory space` };
  }

  switch (toolName) {
    case 'find':
      if (!args.target_uri) args.target_uri = DEFAULT_ROOT;
      break;
    case 'search':
      if (args.mode === 'context') {
        // OV does not accept target_uri in context mode; memories are the one
        // context type that is user-scoped by construction.
        const asked = [].concat(args.context_type ?? []).flatMap((t) => String(t).split(',')).map((t) => t.trim()).filter(Boolean);
        if (asked.length && !asked.includes('memory')) {
          return { error: 'mode="context" through this tool only covers your own memories (context_type memory)' };
        }
        args.context_type = ['memory'];
      } else if (!args.target_uri) {
        args.target_uri = DEFAULT_ROOT;
      }
      break;
    case 'add_resource':
      // OV's default target is the account-shared viking://resources.
      if (!args.to && !args.parent) args.parent = 'viking://~/resources';
      break;
    default:
      break;
  }
  return { args };
}

export function isOwnUri(uri, ownUserId) {
  const u = String(uri ?? '').trim();
  if (!u.startsWith('viking://')) return false;
  // No traversal, encoded or not, and no backslashes: the prefix must mean what it says.
  if (/%2e|%2f|%5c|\\/i.test(u)) return false;
  const rest = u.slice('viking://'.length);
  const segments = rest.split('/');
  if (segments.some((s) => s === '..' || s === '.')) return false;
  if (segments[0] === '~') return true;
  return segments[0] === 'user' && Boolean(ownUserId) && segments[1] === ownUserId;
}

export function makeOvToolHandler({ cfg, registry }) {
  const clients = new Map(); // apiKey → OvMcpClient (initialize once per space)
  const clientFor = (apiKey) => {
    let client = clients.get(apiKey);
    if (!client) {
      client = new OvMcpClient({ baseUrl: cfg.ovBaseUrl, key: apiKey, timeoutMs: cfg.ovTimeoutMs });
      if (clients.size > 500) clients.clear();
      clients.set(apiKey, client);
    }
    return client;
  };

  return async function ovTool(body, ctx) {
    const actor = body.actor ?? {};
    if (actor.type !== 'agent' || !actor.id) {
      throw new Error(`this tool is only callable by an agent (got actor type ${actor.type || 'none'})`);
    }
    // hook keys use kebab-case; OV tool names are snake_case
    const toolName = String(body.hook_key ?? '').replace(/^ov-/, '').replace(/-/g, '_');
    if (!/^[a-z_]+$/.test(toolName)) throw new Error(`invalid facade tool ${toolName}`);

    const ws = ctx?.workspaceId ?? body.workspace_id;
    const key = scopeKey('agent', ws, actor.id);
    const rec = await registry.ensureScope(key, { workspaceId: ws });
    const confined = confineToOwnSpace(toolName, body.input, rec.userId);
    if (confined.error) {
      const e = new Error(confined.error);
      e.code = 'outside_own_space';
      throw e;
    }
    const text = await clientFor(rec.apiKey).callTool(toolName, confined.args);
    return {
      tool: toolName,
      scope: key,
      note: '结果来自你自己的记忆空间(viking://~/,OpenViking 原生工具语义);跨任务协作/工作区共享记忆请用 memory-recall。',
      output: text,
    };
  };
}
