import { createServer } from 'node:http';
import { createHmac, randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** ---------- multica-side signing (mirrors multica's plugin_hook.go) ---------- */

export function makeSigningSecret() {
  return 'whsec_' + randomBytes(32).toString('hex');
}

export function signDelivery({ secret, timestamp = Math.floor(Date.now() / 1000), body }) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'hex');
  const sig = createHmac('sha256', key).update(String(timestamp)).update('.').update(body).digest('hex');
  return { timestamp: String(timestamp), signature: `v1=${sig}` };
}

export function postJson(port, path, body, { headers = {} } = {}) {
  return request(port, 'POST', path, body, headers);
}
export function getJson(port, path, { headers = {} } = {}) {
  return request(port, 'GET', path, undefined, headers);
}

async function request(port, method, path, body, headers = {}) {
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: payload,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, json, text };
}

export function tempStateDir() {
  return mkdtempSync(join(tmpdir(), 'ovmem-test-'));
}

/** ---------- fake OpenViking ---------- */

/**
 * In-process OpenViking stand-in with per-key space isolation: every user key
 * addresses exactly one space. Records all calls for assertions.
 */
export async function startFakeOv({ taskBehavior = 'succeed' } = {}) {
  const spaces = new Map(); // apiKey -> { sessions: Map, files: Map, extracts: [], searches: [] }
  const calls = [];
  const accounts = new Map(); // accountId -> { adminUserId, adminKey, users: Map }
  let taskSeq = 0;
  const taskStates = new Map(); // taskId -> {status, polls}

  function spaceOf(key) {
    if (!spaces.has(key)) spaces.set(key, { sessions: new Map(), files: new Map(), extracts: [], searches: [] });
    return spaces.get(key);
  }

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    let body = {};
    try { body = raw.length ? JSON.parse(raw.toString()) : {}; } catch { /* ignore */ }
    const url = new URL(req.url, 'http://ov');
    const path = url.pathname;
    const key = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const record = { method: req.method, path, key: key.slice(0, 24) };
    calls.push(record);

    const ok = (result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', result }));
    };
    const err = (status, code, message) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: { code, message } }));
    };

    try {
      if (path === '/health') return ok({ status: 'ok', healthy: true, version: 'fake-0.4.22' });
      if (path === '/api/v1/system/status') return ok({ initialized: true, user: key });

      if (path === '/api/v1/admin/accounts' && req.method === 'POST') {
        const { account_id: accountId, admin_user_id: adminUserId } = body;
        if (accounts.has(accountId)) return err(409, 'ALREADY_EXISTS', 'account exists');
        const adminKey = `ovadm-${accountId}-${randomUUID().slice(0, 8)}`;
        accounts.set(accountId, { adminUserId, adminKey, users: new Map() });
        return ok({ account_id: accountId, admin_user_id: adminUserId, user_key: adminKey });
      }
      let m = path.match(/^\/api\/v1\/admin\/accounts\/([^/]+)\/users$/);
      if (m && req.method === 'POST') {
        const acc = accounts.get(decodeURIComponent(m[1]));
        if (!acc) return err(404, 'NOT_FOUND', 'no account');
        if (!acc.adminKey || key !== acc.adminKey) return err(403, 'PERMISSION_DENIED', 'admin key required');
        const { user_id: userId } = body;
        if (acc.users.has(userId)) return err(409, 'ALREADY_EXISTS', 'user exists');
        const userKey = `ovusr-${userId}-${randomUUID().slice(0, 8)}`;
        acc.users.set(userId, userKey);
        spaces.set(userKey, { accountId: m[1], userId, sessions: new Map(), files: new Map(), extracts: [], searches: [] });
        return ok({ user_id: userId, user_key: userKey });
      }
      m = path.match(/^\/api\/v1\/admin\/accounts\/([^/]+)\/users\/([^/]+)\/key$/);
      if (m && req.method === 'POST') {
        const acc = accounts.get(decodeURIComponent(m[1]));
        if (!acc) return err(404, 'NOT_FOUND', 'no account');
        const userId = decodeURIComponent(m[2]);
        const userKey = `ovusr-${userId}-${randomUUID().slice(0, 8)}`;
        acc.users.set(userId, userKey);
        spaces.set(userKey, { accountId: m[1], userId, sessions: new Map(), files: new Map(), extracts: [], searches: [] });
        return ok({ user_id: userId, user_key: userKey });
      }

      const space = spaceOf(key);
      if (path === '/api/v1/sessions' && req.method === 'POST') {
        const sid = body.session_id;
        if (space.sessions.has(sid)) return err(409, 'ALREADY_EXISTS', 'session exists');
        space.sessions.set(sid, { messages: [], committed: false });
        return ok({ session_id: sid });
      }
      m = path.match(/^\/api\/v1\/sessions\/([^/]+)\/messages\/batch$/);
      if (m && req.method === 'POST') {
        const s = space.sessions.get(decodeURIComponent(m[1]));
        if (!s) return err(404, 'NOT_FOUND', 'no session');
        s.messages.push(...(body.messages ?? []));
        return ok({ session_id: m[1], message_count: (body.messages ?? []).length });
      }
      m = path.match(/^\/api\/v1\/sessions\/([^/]+)\/commit$/);
      if (m && req.method === 'POST') {
        const s = space.sessions.get(decodeURIComponent(m[1]));
        if (!s) return err(404, 'NOT_FOUND', 'no session');
        if (s.committed) return ok({ session_id: m[1], status: 'skipped', reason: 'no_messages' });
        s.committed = true;
        s.tags = body?.extraction_metadata?.event?.tags ?? [];
        const taskId = `ovtask-${++taskSeq}`;
        taskStates.set(taskId, { status: 'pending', polls: 0, behavior: taskBehavior, sid: m[1], space: key });
        return ok({ session_id: m[1], status: 'accepted', task_id: taskId, archive_uri: `viking://user/${space.userId}/sessions/${m[1]}/history/archive_001`, archived: true });
      }
      m = path.match(/^\/api\/v1\/sessions\/([^/]+)\/extract$/);
      if (m && req.method === 'POST') {
        space.extracts.push({ sid: decodeURIComponent(m[1]), at: Date.now() });
        // Simulate the proven manual-extract recovery: turn a failed task green.
        for (const t of taskStates.values()) {
          if (t.sid === m[1] && t.behavior === 'fail-once') {
            t.status = 'succeeded';
            t.behavior = 'succeed';
          }
        }
        return ok({ session_id: m[1], status: 'accepted' });
      }
      m = path.match(/^\/api\/v1\/tasks\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const t = taskStates.get(m[1]);
        if (!t) return err(404, 'NOT_FOUND', 'no task');
        t.polls++;
        if (t.status === 'pending' && t.polls >= 2) {
          t.status = t.behavior === 'fail-once' ? 'failed' : 'succeeded';
          if (t.status === 'failed') t.error = 'Error code: 429 - rate limited';
        }
        // Simulate extraction: a succeeded session-commit distills the
        // archived messages into memory files searchable in the same space.
        if (t.status === 'succeeded' && !t.distilled) {
          t.distilled = true;
          const sp = spaceOf(t.space);
          const s = sp.sessions.get(t.sid);
          if (s) {
            const text = s.messages
              .map((msg) => msg.content ?? (msg.parts ?? []).map((p) => p.text ?? p.tool_output ?? '').join(' '))
              .filter(Boolean)
              .join('\n');
            sp.files.set(`memories/events/${t.sid}.md`, text);
          }
        }
        return ok({ task_id: m[1], status: t.status, error: t.error });
      }
      if (path === '/api/v1/search/search' && req.method === 'POST') {
        space.searches.push(body.query);
        const q = String(body.query ?? '');
        const hits = [];
        for (const [uri, file] of space.files) {
          const text = `${uri}\n${file}`;
          // deterministic pseudo-relevance: substring boost + stable base score
          let score = 0.3 + ((uri.length * 13) % 40) / 200;
          if (q && text.includes(q.slice(0, 8))) score += 0.5;
          if (q && text.includes(q)) score += 0.3;
          hits.push({ context_type: 'memory', uri, level: 2, score: Math.min(0.99, score), abstract: file.split('\n').slice(-3).join(' ').slice(0, 120) });
        }
        return ok({ memories: hits.slice(0, body.limit ?? 10), total: hits.length });
      }
      if (path === '/api/v1/content/read') {
        const uri = url.searchParams.get('uri');
        const file = space.files.get(uri);
        if (!file) return err(404, 'NOT_FOUND', 'no file');
        return ok(file); // real OV returns the body as a bare string in result
      }
      if (path === '/api/v1/content/write' && req.method === 'POST') {
        space.files.set(body.uri, body.content);
        return ok({ uri: body.uri, written: true });
      }
      if (path === '/api/v1/fs/ls') {
        const uri = url.searchParams.get('uri') ?? '';
        if (!uri.startsWith('viking://')) return err(400, 'INVALID_URI', 'URI must start with viking://');
        const prefix = uri.endsWith('/') ? uri : uri + '/';
        const entries = [...space.files.entries()]
          .filter(([u]) => u.startsWith(prefix))
          .map(([u, c]) => ({ uri: u, size: c.length, isDir: false, modTime: '2026-09-29T12:00:00Z' }));
        return ok(entries);
      }
      if (path === '/api/v1/content/reindex' && req.method === 'POST') {
        return ok({ reindexed: body.uri });
      }
      return err(404, 'NOT_FOUND', `fake OV has no ${path}`);
    } catch (e) {
      return err(500, 'INTERNAL', String(e.message));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    server, port, baseUrl: `http://127.0.0.1:${port}`,
    spaces, accounts, calls, taskStates,
    filesOf(key) { return spaceOf(key).files; },
    sessionsOf(key) { return spaceOf(key).sessions; },
    async stop() { await new Promise((r) => server.close(r)); },
  };
}

/** ---------- fake multica (callback API + event fixtures) ---------- */

export async function startFakeMultica({ issue, transcript, comments = [] } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mc');
    const path = url.pathname;
    requests.push({ method: req.method, path, token: (req.headers.authorization ?? '').slice(0, 12) });
    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (path === '/v1/context') {
      return json(200, { workspace: { id: issue.workspaceId, name: 'test-ws' }, actor: { type: 'plugin' }, config: {} });
    }
    let m = path.match(/^\/v1\/issues\/([^/]+)$/);
    if (m) {
      const ref = decodeURIComponent(m[1]);
      const found = ref === issue.id || ref === issue.identifier ? issue : null;
      if (!found) return json(404, { error: { code: 'not_found', message: 'unknown issue' } });
      return json(200, found);
    }
    m = path.match(/^\/v1\/issues\/([^/]+)\/comments$/);
    if (m) return json(200, { comments });
    m = path.match(/^\/v1\/tasks\/([^/]+)\/messages$/);
    if (m) {
      const tid = decodeURIComponent(m[1]);
      const since = Number(url.searchParams.get('since') ?? 0);
      const msgs = transcript.filter((t) => t.task_id === tid && t.seq > since);
      return json(200, { messages: msgs });
    }
    return json(404, { error: { code: 'not_found', message: `fake multica has no ${path}` } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    server, port, baseUrl: `http://127.0.0.1:${port}`, requests,
    async stop() { await new Promise((r) => server.close(r)); },
  };
}

export const FIXTURE_WS = '11111111-1111-1111-1111-111111111111';
export const FIXTURE_ISSUE_ID = '22222222-2222-2222-2222-222222222222';
export const FIXTURE_AGENT_A = '33333333-3333-3333-3333-333333333333';
export const FIXTURE_AGENT_B = '44444444-4444-4444-4444-444444444444';
export const FIXTURE_USER = '55555555-5555-5555-5555-555555555555';

export function fixtureIssue() {
  return {
    id: FIXTURE_ISSUE_ID,
    identifier: 'MUL-7',
    title: '为消息推送服务选型并给出迁移方案',
    description: '对比 Kafka 与 RocketMQ,考虑顺序性、死信队列与客户端生态。预算上限 ¥5000/月,需要灰度方案。',
    status: 'open',
    workspaceId: FIXTURE_WS,
  };
}

export function fixtureTranscript({ taskId, agentId = FIXTURE_AGENT_A } = {}) {
  const t = [];
  let seq = 0;
  const push = (msg) => t.push({ task_id: taskId, issue_id: FIXTURE_ISSUE_ID, created_at: new Date().toISOString(), ...msg });
  push({ seq: ++seq, type: 'thinking', content: 'internal reasoning about brokers' });
  push({ seq: ++seq, type: 'text', content: '我先看一下两个候选在顺序性上的差异。' });
  push({ seq: ++seq, type: 'tool_use', tool: 'web_search', call_id: 'call-1', input: { query: 'kafka vs rocketmq ordering' } });
  push({ seq: ++seq, type: 'tool_result', tool: 'web_search', call_id: 'call-1', output: 'Kafka: partition-level ordering. RocketMQ: queue-level + transactional messages.' });
  push({ seq: ++seq, type: 'tool_use', tool: 'multica', call_id: 'call-2', input: { cmd: ['issue', 'list'] } });
  push({ seq: ++seq, type: 'tool_result', tool: 'multica', call_id: 'call-2', output: 'MUL-1..MUL-9 (probe)' });
  push({ seq: ++seq, type: 'text', content: '# Multica Agent Runtime\n你是一个 multica 智能体…(运行时简报)' });
  push({ seq: ++seq, type: 'text', content: '结论:推荐 RocketMQ。理由:顺序性满足、事务消息原生支持、客户端生态完整;预算内。灰度方案:先双写 2 周。' });
  return t;
}

export function hookBody({ eventType, input, callbackUrl, invocationId = `inv-${randomUUID()}`, extra = {} } = {}) {
  return {
    version: 1,
    invocation_id: invocationId,
    delivery_id: '',
    attempt: 1,
    occurred_at: new Date().toISOString(),
    hook_key: 'memory-archive',
    trigger: 'event',
    event_type: eventType,
    workspace_id: FIXTURE_WS,
    installation_id: 'inst-1',
    issue_id: input?.issue_id ?? '',
    actor: { type: 'member', id: FIXTURE_USER },
    input,
    config: {},
    callback_token: 'mpc_testtoken',
    callback_url: callbackUrl,
    ...extra,
  };
}
