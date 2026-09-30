import { shortHash, atomicWriteJson, readJsonIfExists, nowIso } from './util.mjs';

/**
 * Memory scope engine.
 *
 * The functional spec's usage-scope matrix maps onto OpenViking's native
 * multi-tenancy — one OV *account* per multica workspace, one OV *user space*
 * per memory scope. Isolation is structural: a space's key can only read and
 * write that space, so "which memories may this run see" reduces to "which
 * space keys do we search", decided here.
 *
 * Scope taxonomy (scopeKey → one OV user space):
 *   shared:{ws}                        工作区共享记忆
 *   agent:{ws}:{agentId}               智能体公共记忆 (this agent, across tasks)
 *   task:{ws}:{issueId}                任务协作记忆 (per issue, all agents)
 *   dm:{ws}:{agentId}:{userId}         私聊记忆 (agent ↔ human pair)
 *   run:{ws}:{taskId}                  本次运行记忆 (quick-create / single run)
 *   automation:{ws}:{automationId}     自动化记忆
 *   delegation:{ws}:{fromAgent}:{toAgent}  委派通道记忆 (per agent pair)
 *
 * OV ids are deterministic hashes of the scopeKey, so even a lost registry can
 * be rebuilt from the root key (create-or-regenerate recovery).
 */

export const SCOPE_TYPES = ['shared', 'agent', 'task', 'dm', 'run', 'automation', 'delegation'];

export function scopeKey(type, ...parts) {
  if (!SCOPE_TYPES.includes(type)) throw new Error(`unknown scope type: ${type}`);
  for (const p of parts) {
    if (p == null || String(p) === '') throw new Error(`scope ${type} requires all id parts`);
  }
  return [type, ...parts.map(String)].join(':');
}

/** OV identifiers derived deterministically from workspace / scope keys. */
export function accountIdFor(workspaceId) {
  return `mc-${shortHash(`workspace:${workspaceId}`)}`;
}
export function adminUserIdFor(workspaceId) {
  return `mcadmin-${shortHash(`workspace:${workspaceId}`, 8)}`;
}
export function userIdFor(scopeKeyStr) {
  return `mcs-${shortHash(`scope:${scopeKeyStr}`)}`;
}

/** Human label written into the registry for operators. */
export function scopeLabel(scopeKeyStr) {
  const [type, ...rest] = scopeKeyStr.split(':');
  const names = {
    shared: 'workspace shared memory',
    agent: 'agent public memory',
    task: 'task collaboration memory',
    dm: 'direct-message memory',
    run: 'run memory',
    automation: 'automation memory',
    delegation: 'delegation channel memory',
  };
  return `${names[type] ?? type} (${rest.join('/')})`;
}

/**
 * Read-scope matrix — which spaces a context may recall from, in priority
 * order (used as a ranking tiebreak, most specific first).
 *
 * Mirrors the spec's 使用场景 table:
 *   - issue task run:      task + own agent public + shared
 *   - direct chat:         dm(pair) + own agent public + shared
 *   - quick-create run:    run + own agent public + shared
 *   - automation direct:   automation + own agent public + shared
 *   - automation→task:     as issue task run
 *   - delegation receive:  delegation channel + receiving agent public + shared (+ run)
 */
export function resolveReadScopes({ workspaceId, agentId, userId, issueId, taskId, automationId, fromAgentId, toAgentId, kind = 'task' }) {
  const ws = workspaceId;
  const scopes = [];
  switch (kind) {
    case 'task':
      if (issueId) scopes.push(scopeKey('task', ws, issueId));
      if (agentId) scopes.push(scopeKey('agent', ws, agentId));
      scopes.push(scopeKey('shared', ws));
      break;
    case 'chat':
      if (agentId && userId) scopes.push(scopeKey('dm', ws, agentId, userId));
      if (agentId) scopes.push(scopeKey('agent', ws, agentId));
      scopes.push(scopeKey('shared', ws));
      break;
    case 'run':
      if (taskId) scopes.push(scopeKey('run', ws, taskId));
      if (agentId) scopes.push(scopeKey('agent', ws, agentId));
      scopes.push(scopeKey('shared', ws));
      break;
    case 'automation':
      if (automationId) scopes.push(scopeKey('automation', ws, automationId));
      if (agentId) scopes.push(scopeKey('agent', ws, agentId));
      scopes.push(scopeKey('shared', ws));
      break;
    case 'delegation':
      if (fromAgentId && toAgentId) scopes.push(scopeKey('delegation', ws, fromAgentId, toAgentId));
      if (toAgentId) scopes.push(scopeKey('agent', ws, toAgentId));
      if (taskId) scopes.push(scopeKey('run', ws, taskId));
      scopes.push(scopeKey('shared', ws));
      break;
    default:
      throw new Error(`unknown context kind: ${kind}`);
  }
  return scopes;
}

/**
 * Archive-scope matrix — where a context's records land (spec: 归档到哪里).
 */
export function resolveArchiveScope({ workspaceId, agentId, userId, issueId, taskId, automationId, fromAgentId, toAgentId, kind = 'task' }) {
  const ws = workspaceId;
  switch (kind) {
    case 'task':
      return scopeKey('task', ws, issueId);
    case 'chat':
      return scopeKey('dm', ws, agentId, userId);
    case 'run':
      return scopeKey('run', ws, taskId);
    case 'automation':
      return scopeKey('automation', ws, automationId);
    case 'delegation':
      return scopeKey('delegation', ws, fromAgentId, toAgentId);
    default:
      throw new Error(`unknown context kind: ${kind}`);
  }
}

/**
 * Scopes of one agent run, from the host's own description of it
 * (GET /v1/tasks/{id}) — never from tool input the model writes.
 *
 *   issue run      archive → task:{issue}            read ← task + agent + [delegation] + shared
 *   chat run       archive → dm:{agent}:{chat user}  read ← dm + agent + shared
 *   autopilot run  archive → automation:{autopilot}  read ← automation + agent + shared
 *   other runs     archive → run:{task}              read ← run + agent + shared
 *
 * A run delegated by another agent also reads (and records its handoff in) the
 * delegation channel between the two. Returns null when the run's own links are
 * missing (e.g. a chat run without its chat user), so callers skip rather than
 * invent a scope.
 */
export function runScopes({ workspaceId, task }) {
  const ws = workspaceId;
  const agentId = task?.agent_id;
  if (!ws || !agentId || !task?.id) return null;
  let archiveScope;
  switch (task.kind) {
    case 'issue':
      if (!task.issue_id) return null;
      archiveScope = scopeKey('task', ws, task.issue_id);
      break;
    case 'chat':
      if (!task.chat_user_id) return null;
      archiveScope = scopeKey('dm', ws, agentId, task.chat_user_id);
      break;
    case 'autopilot':
      if (!task.autopilot_id) return null;
      archiveScope = scopeKey('automation', ws, task.autopilot_id);
      break;
    default:
      archiveScope = scopeKey('run', ws, task.id);
  }
  const delegationScope = task.delegated_from_agent_id && task.delegated_from_agent_id !== agentId
    ? scopeKey('delegation', ws, task.delegated_from_agent_id, agentId)
    : null;
  const readScopes = [archiveScope, scopeKey('agent', ws, agentId)];
  if (delegationScope) readScopes.push(delegationScope);
  readScopes.push(scopeKey('shared', ws));
  return { kind: task.kind, archiveScope, readScopes, delegationScope };
}

/**
 * Registry + lazy provisioning against a live OpenViking.
 * Persisted at {stateDir}/scopes.json (0600 — it holds space keys).
 */
export class ScopeRegistry {
  constructor({ ov, rootKey, stateDir, log = () => {} }) {
    this.ov = ov;
    this.rootKey = rootKey;
    this.stateDir = stateDir;
    this.log = log;
    this.path = `${stateDir}/scopes.json`;
    this.data = readJsonIfExists(this.path, { accounts: {}, scopes: {} });
    this.data.accounts ??= {};
    this.data.scopes ??= {};
    this.pending = new Map(); // in-flight provisioning dedupe
  }

  save() {
    atomicWriteJson(this.path, this.data, { mode: 0o600 });
  }

  stats() {
    return { accounts: Object.keys(this.data.accounts).length, scopes: Object.keys(this.data.scopes).length };
  }

  /** Ensure the OV account + its admin key exist for a multica workspace. */
  async ensureAccount(workspaceId) {
    const accountId = accountIdFor(workspaceId);
    const adminUserId = adminUserIdFor(workspaceId);
    const cached = this.data.accounts[accountId];
    if (cached?.adminKey) return { accountId, adminKey: cached.adminKey };

    if (this.pending.has(accountId)) return this.pending.get(accountId);
    const p = (async () => {
      const created = await this.ov.createAccount(this.rootKey, { accountId, adminUserId });
      let adminKey = created?.user_key ?? null;
      if (!adminKey) {
        // Account existed (or key withheld): (re)mint the admin user key.
        const regen = await this.ov.regenerateKey(this.rootKey, accountId, adminUserId);
        adminKey = regen?.user_key ?? regen?.key ?? null;
      }
      if (!adminKey) throw new Error(`could not obtain admin key for account ${accountId}`);
      this.data.accounts[accountId] = { workspaceId, adminUserId, adminKey, createdAt: cached?.createdAt ?? nowIso() };
      this.save();
      return { accountId, adminKey };
    })().finally(() => this.pending.delete(accountId));
    this.pending.set(accountId, p);
    return p;
  }

  /** Ensure the OV user space for a scope key exists; returns its API key. */
  async ensureScope(scopeKeyStr, { workspaceId } = {}) {
    const existing = this.data.scopes[scopeKeyStr];
    if (existing?.apiKey) return { ...existing, scopeKey: scopeKeyStr };

    const wsId = workspaceId ?? existing?.workspaceId ?? scopeKeyStr.split(':')[1];
    if (this.pending.has(scopeKeyStr)) return this.pending.get(scopeKeyStr);
    const p = (async () => {
      const { accountId, adminKey } = await this.ensureAccount(wsId);
      const userId = userIdFor(scopeKeyStr);
      let record = {
        scopeKey: scopeKeyStr,
        workspaceId: wsId,
        accountId,
        userId,
        label: scopeLabel(scopeKeyStr),
        createdAt: existing?.createdAt ?? nowIso(),
      };
      const created = await this.ov.createUser(adminKey, accountId, { userId });
      let apiKey = created?.user_key ?? null;
      if (!apiKey) {
        const regen = await this.ov.regenerateKey(adminKey, accountId, userId);
        apiKey = regen?.user_key ?? regen?.key ?? null;
      }
      if (!apiKey) throw new Error(`could not obtain key for scope ${scopeKeyStr}`);
      record = { ...record, apiKey, provisionedAt: nowIso() };
      this.data.scopes[scopeKeyStr] = record;
      this.save();
      this.log(`scope provisioned: ${scopeKeyStr} -> account=${accountId} user=${userId}`);
      return record;
    })().finally(() => this.pending.delete(scopeKeyStr));
    this.pending.set(scopeKeyStr, p);
    return p;
  }

  /** Look up without provisioning (recall skips absent scopes silently). */
  get(scopeKeyStr) {
    const rec = this.data.scopes[scopeKeyStr];
    return rec?.apiKey ? { ...rec, scopeKey: scopeKeyStr } : null;
  }

  /** Provision-or-return for read paths that must have the space (archives). */
  async ensureForArchive(scopeKeyStr, workspaceId) {
    return this.ensureScope(scopeKeyStr, { workspaceId });
  }
}
