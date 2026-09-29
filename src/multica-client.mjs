import { fetchJson } from './util.mjs';

/**
 * Multica plugin callback API client (the /v1 surface granted to this
 * installation). One instance per hook delivery: the callback token (mpc_…)
 * is short-lived and scoped to the invocation.
 */
export class MulticaClient {
  constructor({ callbackUrl, callbackToken, timeoutMs = 15_000, fetchImpl } = {}) {
    this.baseUrl = String(callbackUrl || '').replace(/\/+$/, '');
    this.token = callbackToken;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    if (!this.baseUrl) throw new Error('MulticaClient requires callbackUrl');
  }

  async call(path, { method = 'GET', body } = {}) {
    const headers = { Authorization: `Bearer ${this.token}` };
    return fetchJson(`${this.baseUrl}${path}`, {
      method,
      headers,
      body,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }

  /** Workspace / actor / config context for this invocation. */
  getContext() {
    return this.call('/context');
  }

  /**
   * Issue by UUID or key. 404 means unknown OR outside the granted scope,
   * which for us doubles as the issue-membership check for tool calls.
   */
  getIssue(ref) {
    return this.call(`/issues/${encodeURIComponent(ref)}`);
  }

  /** Chronological comment list (newest 200). */
  listComments(ref) {
    return this.call(`/issues/${encodeURIComponent(ref)}/comments`);
  }

  /**
   * Run transcript (requires the multica task-messages companion endpoint,
   * GET /v1/tasks/{task_id}/messages; present in multica builds carrying the
   * transcript patch — the plugin degrades gracefully without it).
   * Response shape varies by build: a bare array, or {"messages": [...]}.
   */
  async getTaskMessages(taskId, { since = 0, includeThinking = false } = {}) {
    const qs = new URLSearchParams();
    if (since) qs.set('since', String(since));
    if (!includeThinking) qs.set('include', 'thinking=false');
    const suffix = qs.toString() ? `?${qs}` : '';
    const resp = await this.call(`/tasks/${encodeURIComponent(taskId)}/messages${suffix}`);
    if (Array.isArray(resp)) return { messages: resp };
    return resp;
  }
}
