import { fetchJson, timeLeft, withRetry } from './util.mjs';

/**
 * Minimal OpenViking REST client.
 *
 * Auth model: every data-plane call carries one OV user/admin key via
 * `Authorization: Bearer <key>`; each key reads/writes exactly its own user
 * space, which is what makes scope isolation structural rather than advisory.
 * The ROOT key is used only for account provisioning.
 *
 * Envelope: `{status, result, error, telemetry}` — result is returned, errors
 * throw with `.code` / `.status` attached.
 */
export class OvClient {
  constructor({ baseUrl, timeoutMs = 30_000, fetchImpl } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    if (!this.baseUrl) throw new Error('OvClient requires baseUrl');
  }

  url(path) {
    return `${this.baseUrl}${path}`;
  }

  async call(path, { method = 'GET', key, body, timeoutMs, raw = false } = {}) {
    const headers = {};
    if (key) headers.Authorization = `Bearer ${key}`;
    return fetchJson(this.url(path), {
      method,
      headers,
      body,
      timeoutMs: timeoutMs ?? this.timeoutMs,
      fetchImpl: this.fetchImpl,
    }).then((json) => {
      if (raw) return json;
      if (json && typeof json === 'object' && 'result' in json) return json.result;
      return json;
    });
  }

  // ---- system ----

  async health() {
    return fetchJson(this.url('/health'), { fetchImpl: this.fetchImpl, timeoutMs: 8_000 });
  }

  async systemStatus(key) {
    return this.call('/api/v1/system/status', { key });
  }

  // ---- provisioning (ROOT / account-admin) ----

  /**
   * Create an account (one per multica workspace). Returns the account-scoped
   * admin user key inline (OpenViking ≥0.4.22). Tolerates "already exists"
   * so callers can fall back to key regeneration.
   */
  async createAccount(rootKey, { accountId, adminUserId }) {
    try {
      return await this.call('/api/v1/admin/accounts', {
        method: 'POST',
        key: rootKey,
        body: { account_id: accountId, admin_user_id: adminUserId },
      });
    } catch (err) {
      if (isAlreadyExists(err)) return { account_id: accountId, user_key: null, existed: true };
      throw err;
    }
  }

  async listAccounts(rootKey, { query } = {}) {
    const qs = query ? `?query=${encodeURIComponent(query)}` : '';
    return this.call(`/api/v1/admin/accounts${qs}`, { key: rootKey });
  }

  /** Register a user under an account; returns its key inline. */
  async createUser(accountAdminKey, accountId, { userId }) {
    try {
      return await this.call(`/api/v1/admin/accounts/${encodeURIComponent(accountId)}/users`, {
        method: 'POST',
        key: accountAdminKey,
        body: { user_id: userId, role: 'user' },
      });
    } catch (err) {
      if (isAlreadyExists(err)) return { user_id: userId, user_key: null, existed: true };
      throw err;
    }
  }

  /** (Re)mint a user's key — recovery path when the registry lost an entry. */
  async regenerateKey(adminKey, accountId, userId) {
    return this.call(`/api/v1/admin/accounts/${encodeURIComponent(accountId)}/users/${encodeURIComponent(userId)}/key`, {
      method: 'POST',
      key: adminKey,
    });
  }

  async listUsers(adminKey, accountId) {
    return this.call(`/api/v1/admin/accounts/${encodeURIComponent(accountId)}/users?include_credentials=false&limit=200`, {
      key: adminKey,
    });
  }

  // ---- sessions (data plane, per-scope key) ----

  async createSession(key, { sessionId, autoCommitPolicy = null }) {
    const body = { session_id: sessionId };
    if (autoCommitPolicy !== undefined) body.auto_commit_policy = autoCommitPolicy;
    try {
      return await this.call('/api/v1/sessions', { method: 'POST', key, body });
    } catch (err) {
      if (isConflict(err)) return { session_id: sessionId, existed: true };
      throw err;
    }
  }

  async getSession(key, sessionId) {
    return this.call(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { key });
  }

  /**
   * Batch-add messages (≤100 per call, chunking handled by the caller).
   * Deliberately NOT retried here: a POST whose response was lost may still have
   * landed, and a blind retry would duplicate the batch. The archive pipeline
   * resumes from the session's live message_count instead.
   */
  async addMessages(key, sessionId, messages) {
    return this.call(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages/batch`, {
      method: 'POST',
      key,
      body: { messages },
    });
  }

  async commitSession(key, sessionId, { tags = [] } = {}) {
    const body = {};
    if (tags.length) body.extraction_metadata = { event: { tags } };
    return this.call(`/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`, { method: 'POST', key, body });
  }

  async extractSession(key, sessionId) {
    return this.call(`/api/v1/sessions/${encodeURIComponent(sessionId)}/extract`, { method: 'POST', key, body: {} });
  }

  async getTask(key, taskId) {
    return this.call(`/api/v1/tasks/${encodeURIComponent(taskId)}`, { key });
  }

  /** Background tasks for one resource (e.g. the commit tasks of a session). */
  async listTasks(key, { resourceId, taskType } = {}) {
    const qs = new URLSearchParams();
    if (resourceId) qs.set('resource_id', resourceId);
    if (taskType) qs.set('task_type', taskType);
    const result = await this.call(`/api/v1/tasks?${qs}`, { key });
    return Array.isArray(result) ? result : (result?.tasks ?? []);
  }

  // ---- retrieval ----

  /**
   * List-mode semantic search in ONE user space (the key's own).
   * Only minimal fields are sent: the server rejects unknown params
   * (`extra="forbid"`), e.g. both top_k and entries.
   * `deadline` (epoch ms) bounds the whole call, retry included.
   */
  async search(key, { query, limit = 10, readContent = false, deadline = Infinity }) {
    const body = { query, mode: 'list', limit };
    if (readContent) body.read_content = true;
    // Retrieval sits right after extraction bursts — transient provider errors
    // (embedding rate limits) are common enough to warrant one quiet retry.
    return withRetry(
      () => this.call('/api/v1/search/search', { method: 'POST', key, body, timeoutMs: timeLeft(deadline, this.timeoutMs) }),
      { attempts: 2, deadline },
    );
  }

  /** Read a file; offset is a 0-indexed line number (OV's own convention). */
  async readContent(key, uri, { offset = 0, limit = 400, deadline = Infinity } = {}) {
    const qs = `?uri=${encodeURIComponent(uri)}&offset=${offset}&limit=${limit}`;
    const result = await this.call(`/api/v1/content/read${qs}`, { key, timeoutMs: timeLeft(deadline, this.timeoutMs) });
    // v0.4.x returns the body as a bare string in result (with uri echoed on some versions)
    const content = typeof result === 'string' ? result : result?.content;
    return { uri, content: typeof content === 'string' ? content : undefined };
  }

  // ---- active writes (agent-curated memories) ----

  async writeContent(key, { uri, content, mode = 'create' }) {
    return this.call('/api/v1/content/write', { method: 'POST', key, body: { uri, content, mode } });
  }

  /** mode: vectors_only (OV default) | semantic_and_vectors (also rebuilds L0/L1 summaries). */
  async reindex(key, uri, { mode, recursive, wait } = {}) {
    const body = { uri };
    if (mode) body.mode = mode;
    if (recursive !== undefined) body.recursive = recursive;
    if (wait !== undefined) body.wait = wait;
    return this.call('/api/v1/content/reindex', { method: 'POST', key, body });
  }

  /** List a directory (absolute viking:// URIs only; returns entries array). */
  async listDir(key, uri) {
    const result = await this.call(`/api/v1/fs/ls?uri=${encodeURIComponent(uri)}`, { key });
    return Array.isArray(result) ? result : (result?.entries ?? []);
  }
}

export function isAlreadyExists(err) {
  const c = String(err.code ?? '');
  const msg = String(err.message ?? '');
  // "does not exist" is a missing target, not a duplicate.
  return c === 'ALREADY_EXISTS' || /already\s+exists?|exists\s+already/i.test(msg) || err.status === 409;
}

function isConflict(err) {
  return err.status === 409 || String(err.code ?? '') === 'ALREADY_EXISTS';
}
