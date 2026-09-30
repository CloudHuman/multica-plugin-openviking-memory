// Minimal client for a REAL multica server: member auth, workspace and plugin
// lifecycle, and the daemon endpoints an agent runtime drives a run through.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Multica {
  constructor({ base, devCode = '888888' }) {
    this.base = base.replace(/\/+$/, '');
    this.devCode = devCode;
  }

  async call(path, { method = 'GET', token, ws, body, form } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (ws) headers['X-Workspace-ID'] = ws;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${this.base}${path}`, {
      method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
  }

  async must(label, promise) {
    const r = await promise;
    if (r.status >= 300) throw new Error(`${label}: HTTP ${r.status} ${r.text.slice(0, 400)}`);
    return r.json;
  }

  /** Dev login (APP_ENV=development + MULTICA_DEV_VERIFICATION_CODE). */
  async login(email) {
    await this.must('send-code', this.call('/auth/send-code', { method: 'POST', body: { email } }));
    const v = await this.must('verify-code', this.call('/auth/verify-code', { method: 'POST', body: { email, code: this.devCode } }));
    return { token: v.token, userId: v.user?.id };
  }

  async createWorkspace(token, { name, slug, prefix }) {
    const ws = await this.must('create workspace', this.call('/api/workspaces', { method: 'POST', token, body: { name, slug, issue_prefix: prefix } }));
    return ws.id ?? ws.workspace?.id;
  }

  /** Upload a plugin zip; returns the raw response so callers can inspect a refusal. */
  async publishPlugin(token, ws, zipPath) {
    const form = new FormData();
    form.append('bundle', new Blob([readFileSync(zipPath)], { type: 'application/zip' }), 'plugin.zip');
    return this.call(`/api/workspaces/${ws}/plugins/packages`, { method: 'POST', token, ws, form });
  }

  /** Preview → install granting every requested scope → rotate credentials. */
  async installPlugin(token, ws, versionId) {
    const prev = await this.must('preview', this.call(`/api/workspaces/${ws}/plugins/preview`, { method: 'POST', token, body: { version_id: versionId } }));
    const scopes = prev.scopes?.map((s) => s.scope ?? s) ?? prev.manifest?.scopes;
    const inst = await this.must('install', this.call(`/api/workspaces/${ws}/plugins`, { method: 'POST', token, body: { version_id: versionId, granted_scopes: scopes } }));
    const installationId = inst.id ?? inst.installation?.id;
    const rot = await this.must('rotate token', this.call(`/api/workspaces/${ws}/plugins/${installationId}/token`, { method: 'POST', token }));
    return { installationId, scopes, signingSecret: rot.signing_secret, installationToken: rot.token };
  }

  async createIssue(token, ws, { title, description }) {
    return this.must('create issue', this.call('/api/issues', { method: 'POST', token, ws, body: { title, description } }));
  }

  async assign(token, ws, issueId, agentId) {
    return this.must('assign issue', this.call(`/api/issues/${issueId}`, { method: 'PUT', token, ws, body: { assignee_type: 'agent', assignee_id: agentId } }));
  }

  async comment(token, ws, issueId, content) {
    return this.must('comment', this.call(`/api/issues/${issueId}/comments`, { method: 'POST', token, ws, body: { content } }));
  }

  /** A daemon with one runtime, driven through the same endpoints the real daemon uses. */
  async daemon(token, ws) {
    const reg = await this.must('daemon register', this.call('/api/daemon/register', {
      method: 'POST', token, ws,
      body: { workspace_id: ws, daemon_id: randomUUID(), device_name: 'ovmem-e2e-daemon', cli_version: '0.6.0', runtimes: [{ name: 'opencode', type: 'opencode', version: '1.0.0', status: 'online' }] },
    }));
    const runtimeId = reg.runtimes[0].id;
    const mc = this;
    const beat = () => mc.call('/api/daemon/heartbeat', { method: 'POST', token, ws, body: { runtime_id: runtimeId } }).catch(() => {});
    const timer = setInterval(beat, 5_000);
    timer.unref?.();
    return {
      runtimeId,
      stop: () => clearInterval(timer),
      createAgent: (name) => mc.must(`create agent ${name}`, mc.call('/api/agents', {
        method: 'POST', token, ws,
        body: { name, description: `${name} (e2e)`, instructions: 'e2e agent', runtime_id: runtimeId, visibility: 'workspace', max_concurrent_tasks: 4 },
      })),
      /** Claim the next task for `agentId` (optionally matching a predicate) and start it. */
      async claimAndStart(agentId, match = () => true, { timeoutMs = 20_000 } = {}) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          await beat();
          const r = await mc.call(`/api/daemon/runtimes/${runtimeId}/tasks/claim`, { method: 'POST', token, ws, body: {} });
          const task = r.json?.task ?? null;
          if (task) {
            if (task.agent_id !== agentId || !match(task)) throw new Error(`claimed an unexpected task ${task.id} (agent ${task.agent_id})`);
            await mc.must('start task', mc.call(`/api/daemon/tasks/${task.id}/start`, { method: 'POST', token, ws, body: {} }));
            return task;
          }
          await sleep(500);
        }
        throw new Error(`no task to claim for agent ${agentId}`);
      },
      report: (taskId, messages) => mc.must('report messages', mc.call(`/api/daemon/tasks/${taskId}/messages`, { method: 'POST', token, ws, body: { messages } })),
      complete: (taskId, output) => mc.must('complete task', mc.call(`/api/daemon/tasks/${taskId}/complete`, { method: 'POST', token, ws, body: { output } })),
      /** An agent tool call: daemon → multica → signed hook → plugin. Returns the plugin's body. */
      async hook(taskId, installationId, hookKey, input) {
        const r = await mc.call(`/api/daemon/tasks/${taskId}/plugin-hooks`, { method: 'POST', token, ws, body: { installation_id: installationId, hook_key: hookKey, input } });
        const out = r.json?.output ?? null;
        return { http: r.status, hookStatus: r.json?.status, status: out?.status, result: out?.result, error: out?.error ?? r.json?.error };
      },
    };
  }
}
