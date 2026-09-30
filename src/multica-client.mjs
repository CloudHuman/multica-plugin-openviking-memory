import { fetchJson } from './util.mjs';

/**
 * Multica plugin callback API client (the /v1 surface granted to this
 * installation). One instance per hook delivery: the callback token (mpc_…)
 * is scoped to the invocation and revoked the moment the hook call returns, so
 * everything a handler needs must be fetched before it answers.
 */
export class MulticaClient {
  constructor({ callbackUrl, callbackToken, timeoutMs = 5_000, fetchImpl, deadline = Infinity } = {}) {
    this.baseUrl = String(callbackUrl || '').replace(/\/+$/, '');
    this.token = callbackToken;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.deadline = deadline;
  }

  get available() {
    return Boolean(this.baseUrl && this.token);
  }

  async call(path, { method = 'GET', body } = {}) {
    if (!this.available) {
      const e = new Error('no multica callback (hook body carried no callback_url/callback_token)');
      e.code = 'NO_CALLBACK';
      throw e;
    }
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) {
      const e = new Error('callback budget exhausted');
      e.code = 'BUDGET';
      throw e;
    }
    return fetchJson(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}` },
      body,
      timeoutMs: Math.min(this.timeoutMs, remaining),
      fetchImpl: this.fetchImpl,
    });
  }

  /** Workspace / actor / config context for this invocation. */
  getContext() {
    return this.call('/context');
  }

  /**
   * Issue by UUID or key. The response's `id` is the canonical UUID — callers
   * that key anything by issue must use it, never the ref they were given.
   */
  async getIssue(ref) {
    const resp = await this.call(`/issues/${encodeURIComponent(ref)}`);
    return resp && typeof resp === 'object' && 'issue' in resp ? resp.issue : resp;
  }

  /**
   * One agent run: kind, links and the input that started it. Requires the
   * multica Plugin API task slice (GET /v1/tasks/{id}); stock builds answer 404,
   * which callers treat as "run details unavailable".
   */
  getTask(taskId) {
    return this.call(`/tasks/${encodeURIComponent(taskId)}`);
  }

  /**
   * The run transcript, following next_cursor pages until done, the message cap,
   * or the fetch budget. Returns { messages, complete }.
   */
  async listTaskMessages(taskId, { maxMessages = 2_000, pageSize = 200 } = {}) {
    const messages = [];
    let cursor = '';
    for (;;) {
      const qs = new URLSearchParams({ limit: String(pageSize) });
      if (cursor) qs.set('cursor', cursor);
      let page;
      try {
        page = await this.call(`/tasks/${encodeURIComponent(taskId)}/messages?${qs}`);
      } catch (err) {
        // Keep what arrived if a later page runs out of time; a first-page
        // failure is the caller's to classify (404 = no task API, 403 = scope).
        if (messages.length && (err.code === 'BUDGET' || err.code === 'NETWORK')) return { messages, complete: false };
        throw err;
      }
      const batch = Array.isArray(page) ? page : (page?.messages ?? []);
      messages.push(...batch);
      cursor = Array.isArray(page) ? '' : (page?.next_cursor ?? '');
      if (!cursor) return { messages, complete: true };
      if (messages.length >= maxMessages) return { messages: messages.slice(0, maxMessages), complete: false };
    }
  }
}

export const isNotFound = (err) => err?.status === 404;
export const isForbidden = (err) => err?.status === 403;
