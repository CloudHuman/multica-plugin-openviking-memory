import { createServer } from 'node:http';
import { createHmac, randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Test doubles for multica and OpenViking. Their behaviour follows the REAL
 * contracts, checked against multica v0.6 and OpenViking v0.4.22 — the earlier
 * fakes were friendlier than the real services (an extract that healed failed
 * tasks, a read that ignored offsets, a comment shape multica never sends), and
 * every one of those kindnesses hid a bug.
 */

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
 * addresses exactly one user space. Session semantics follow v0.4.22:
 *   - commit moves ALL live messages into history/archive_NNN and clears the
 *     live list; a commit with no live messages is `skipped`;
 *   - POST /sessions/{id}/extract extracts from LIVE messages only — after a
 *     commit there are none, so it returns [] and changes nothing;
 *   - GET /sessions/{id} reports message_count (live) and commit_count;
 *   - content/read takes a 0-indexed line offset;
 *   - a finished extraction writes `.done` in the archive, a failed one
 *     `.failed.json`; GET /tasks?resource_id= lists a session's commit tasks.
 *
 * taskBehavior: 'succeed' | 'fail-first' (the first commit task in a space
 * fails, later ones succeed) | 'fail-always'.
 */
export async function startFakeOv({ taskBehavior = 'succeed', pollsToFinish = 1 } = {}) {
  const spaces = new Map(); // apiKey -> space
  const calls = [];
  const searchDelayMs = new Map(); // apiKey -> ms a search in that space takes (a slow model provider)
  const accounts = new Map(); // accountId -> { adminUserId, adminKey, users: Map }
  let taskSeq = 0;
  const taskStates = new Map(); // taskId -> {status, polls, sid, space, archive}
  let failuresLeft = taskBehavior === 'fail-first' ? 1 : taskBehavior === 'fail-always' ? Infinity : 0;

  function newSpace(accountId, userId) {
    return { accountId, userId, sessions: new Map(), files: new Map(), extracts: [], searches: [] };
  }
  function spaceOf(key) {
    if (!spaces.has(key)) spaces.set(key, newSpace(null, null));
    return spaces.get(key);
  }
  const userRoot = (space) => `viking://user/${space.userId}`;
  // Real OV accepts explicit viking:// URIs only and expands the viking://~ alias.
  const resolveUri = (space, uri) => {
    const u = String(uri ?? '');
    if (!u.startsWith('viking://')) return null;
    return u.startsWith('viking://~') ? userRoot(space) + u.slice('viking://~'.length) : u;
  };

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    let body = {};
    try { body = raw.length ? JSON.parse(raw.toString()) : {}; } catch { /* ignore */ }
    const url = new URL(req.url, 'http://ov');
    const path = url.pathname;
    const key = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    calls.push({ method: req.method, path, key: key.slice(0, 24), body });

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

      if (path === '/api/v1/admin/accounts' && req.method === 'POST') {
        const { account_id: accountId, admin_user_id: adminUserId } = body;
        if (accounts.has(accountId)) return err(409, 'ALREADY_EXISTS', 'account exists');
        const adminKey = `ovadm-${accountId}-${randomUUID().slice(0, 8)}`;
        accounts.set(accountId, { adminUserId, adminKey, users: new Map() });
        spaces.set(adminKey, newSpace(accountId, adminUserId));
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
        spaces.set(userKey, newSpace(m[1], userId));
        return ok({ user_id: userId, user_key: userKey });
      }
      m = path.match(/^\/api\/v1\/admin\/accounts\/([^/]+)\/users\/([^/]+)\/key$/);
      if (m && req.method === 'POST') {
        const acc = accounts.get(decodeURIComponent(m[1]));
        if (!acc) return err(404, 'NOT_FOUND', 'no account');
        const userId = decodeURIComponent(m[2]);
        const userKey = `ovusr-${userId}-${randomUUID().slice(0, 8)}`;
        acc.users.set(userId, userKey);
        spaces.set(userKey, newSpace(m[1], userId));
        return ok({ user_id: userId, user_key: userKey });
      }

      const space = spaceOf(key);
      if (path === '/api/v1/sessions' && req.method === 'POST') {
        const sid = body.session_id;
        if (space.sessions.has(sid)) return err(409, 'ALREADY_EXISTS', 'session exists');
        space.sessions.set(sid, { live: [], archives: [], commitCount: 0, autoCommit: body.auto_commit_policy });
        return ok({ session_id: sid });
      }
      m = path.match(/^\/api\/v1\/sessions\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const s = space.sessions.get(decodeURIComponent(m[1]));
        if (!s) return err(404, 'NOT_FOUND', 'no session');
        return ok({ session_id: m[1], message_count: s.live.length, commit_count: s.commitCount });
      }
      m = path.match(/^\/api\/v1\/sessions\/([^/]+)\/messages\/batch$/);
      if (m && req.method === 'POST') {
        const s = space.sessions.get(decodeURIComponent(m[1]));
        if (!s) return err(404, 'NOT_FOUND', 'no session');
        for (const msg of body.messages ?? []) {
          for (const part of msg.parts ?? []) {
            if (part.type === 'tool' && part.tool_input !== undefined && (typeof part.tool_input !== 'object' || Array.isArray(part.tool_input))) {
              return err(400, 'INVALID_ARGUMENT', 'tool_input must be an object');
            }
          }
        }
        s.live.push(...(body.messages ?? []));
        return ok({ session_id: m[1], message_count: s.live.length, added: (body.messages ?? []).length });
      }
      m = path.match(/^\/api\/v1\/sessions\/([^/]+)\/commit$/);
      if (m && req.method === 'POST') {
        const sid = decodeURIComponent(m[1]);
        const s = space.sessions.get(sid);
        if (!s) return err(404, 'NOT_FOUND', 'no session');
        for (const tag of body?.extraction_metadata?.event?.tags ?? []) {
          if (String(tag).split('=').length !== 2 || !String(tag).split('=')[1]) {
            return err(400, 'INVALID_ARGUMENT', `invalid search tag '${tag}': expected strict k=v format`);
          }
        }
        if (!s.live.length) return ok({ session_id: sid, status: 'skipped', task_id: null, reason: 'no_messages', archived: false });
        s.commitCount += 1;
        const archiveUri = `${userRoot(space)}/sessions/${sid}/history/archive_${String(s.commitCount).padStart(3, '0')}`;
        const archive = { uri: archiveUri, messages: s.live, tags: body?.extraction_metadata?.event?.tags ?? [] };
        s.archives.push(archive);
        s.live = [];
        s.tags = archive.tags;
        const taskId = `ovtask-${++taskSeq}`;
        const fails = failuresLeft > 0;
        if (fails) failuresLeft -= 1;
        taskStates.set(taskId, { status: 'pending', polls: 0, fails, sid, space: key, archive, createdAt: Date.now() / 1000 });
        return ok({ session_id: sid, status: 'accepted', task_id: taskId, archive_uri: archiveUri, archived: true });
      }
      m = path.match(/^\/api\/v1\/sessions\/([^/]+)\/extract$/);
      if (m && req.method === 'POST') {
        const s = space.sessions.get(decodeURIComponent(m[1]));
        space.extracts.push({ sid: decodeURIComponent(m[1]), at: Date.now(), live: s?.live.length ?? 0 });
        // Real OV: extraction over the LIVE messages, which a commit emptied.
        return ok([]);
      }
      if (path === '/api/v1/tasks' && req.method === 'GET') {
        const rid = url.searchParams.get('resource_id');
        const list = [...taskStates.entries()]
          .filter(([, t]) => t.space === key && (!rid || t.sid === rid))
          .map(([id, t]) => ({ task_id: id, status: t.status, resource_id: t.sid, created_at: t.createdAt, result: { archive_uri: t.archive.uri } }));
        return ok(list);
      }
      m = path.match(/^\/api\/v1\/tasks\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const t = taskStates.get(m[1]);
        if (!t || t.space !== key) return err(404, 'NOT_FOUND', 'no task');
        t.polls++;
        if (t.status === 'pending' && t.polls >= pollsToFinish) {
          t.status = t.fails ? 'failed' : 'completed';
          if (t.fails) {
            t.error = 'Error code: 429 - rate limited';
            spaceOf(t.space).files.set(`${t.archive.uri}/.failed.json`, JSON.stringify({ error: t.error }));
          } else {
            // Distil: the archived messages become a memory file in the space.
            const sp = spaceOf(t.space);
            const text = t.archive.messages
              .map((msg) => msg.content ?? (msg.parts ?? []).map((p) => p.text ?? p.tool_output ?? '').join(' '))
              .filter(Boolean)
              .join('\n');
            sp.files.set(`${userRoot(sp)}/memories/events/${t.sid}.md`, text);
            sp.files.set(`${t.archive.uri}/.done`, '{}');
          }
        }
        return ok({ task_id: m[1], status: t.status, error: t.error });
      }
      if (path === '/api/v1/search/search' && req.method === 'POST') {
        space.searches.push(body.query);
        if (searchDelayMs.get(key)) await new Promise((r) => setTimeout(r, searchDelayMs.get(key)));
        const q = String(body.query ?? '');
        const hits = [];
        for (const [uri, file] of space.files) {
          if (!uri.includes('/memories/')) continue;
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
        const uri = resolveUri(space, url.searchParams.get('uri'));
        if (!uri) return err(400, 'INVALID_URI', 'URI must start with viking://');
        const file = space.files.get(uri);
        if (file === undefined) return err(404, 'NOT_FOUND', 'no file');
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? -1);
        const lines = file.split('\n');
        const slice = limit < 0 ? lines.slice(offset) : lines.slice(offset, offset + limit);
        return ok(slice.join('\n')); // real OV returns the body as a bare string in result
      }
      if (path === '/api/v1/content/write' && req.method === 'POST') {
        const uri = resolveUri(space, body.uri);
        if (!uri) return err(400, 'INVALID_URI', 'URI must start with viking://');
        if (body.mode === 'create' && space.files.has(uri)) return err(409, 'ALREADY_EXISTS', `file already exists: ${uri}`);
        space.files.set(uri, body.content);
        return ok({ uri, written: true });
      }
      if (path === '/api/v1/fs/ls') {
        const uri = url.searchParams.get('uri') ?? '';
        if (!uri.startsWith('viking://')) return err(400, 'INVALID_URI', 'URI must start with viking://');
        const prefix = uri.endsWith('/') ? uri : uri + '/';
        const entries = [...space.files.entries()]
          .filter(([u]) => u.startsWith(prefix) && !u.split('/').pop().startsWith('.'))
          .map(([u, c]) => ({ uri: u, size: c.length, isDir: false, modTime: '2026-09-29T12:00:00Z' }));
        return ok(entries);
      }
      if (path === '/api/v1/content/reindex' && req.method === 'POST') {
        space.reindexes = [...(space.reindexes ?? []), body];
        return ok({ status: body.wait === false ? 'accepted' : 'completed', uri: body.uri, mode: body.mode ?? 'vectors_only' });
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
    spaces, accounts, calls, taskStates, searchDelayMs,
    filesOf(key) { return spaceOf(key).files; },
    sessionsOf(key) { return spaceOf(key).sessions; },
    /** Every message a session ever archived, across commits. */
    archivedOf(key, sid) { return (spaceOf(key).sessions.get(sid)?.archives ?? []).flatMap((a) => a.messages); },
    async stop() { await new Promise((r) => server.close(r)); },
  };
}

/** ---------- fake multica (Plugin Action API + event fixtures) ---------- */

/**
 * taskApi: true  → multica with the task read slice (GET /v1/tasks/{id}[/messages])
 *          false → stock multica: those paths answer 404, like v0.6.
 * tasks:  { [taskId]: task payload as GET /v1/tasks/{id} returns it }
 * transcript: [{task_id, seq, type, ...}]
 */
export async function startFakeMultica({ issue, issues = [], transcript = [], comments = [], tasks = {}, taskApi = false, workspaceId } = {}) {
  const requests = [];
  const allIssues = [issue, ...issues].filter(Boolean);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mc');
    const path = url.pathname;
    const token = req.headers.authorization ?? '';
    requests.push({ method: req.method, path, query: url.search, token: token.slice(0, 12) });
    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const problem = (status, code, detail) => json(status, { type: `urn:multica:problem:${code}`, title: code, status, code, detail, error: detail });
    if (!token.startsWith('Bearer mpc_') && !token.startsWith('Bearer mpi_')) return problem(401, 'unauthorized', 'plugin token required');
    if (path === '/v1/context') {
      return json(200, { workspace: { id: workspaceId ?? issue?.workspace_id ?? issue?.workspaceId, name: 'test-ws', slug: 'test' }, config: {}, granted_net_domains: [], actor: 'plugin' });
    }
    let m = path.match(/^\/v1\/issues\/([^/]+)$/);
    if (m) {
      const ref = decodeURIComponent(m[1]);
      const found = allIssues.find((i) => ref === i.id || ref === i.identifier);
      if (!found) return problem(404, 'not_found', 'issue not found');
      return json(200, found);
    }
    m = path.match(/^\/v1\/issues\/([^/]+)\/comments$/);
    if (m) return json(200, { comments });
    m = path.match(/^\/v1\/tasks\/([^/]+)$/);
    if (m) {
      if (!taskApi) return problem(404, 'not_found', 'resource not found');
      const task = tasks[decodeURIComponent(m[1])];
      return task ? json(200, task) : problem(404, 'not_found', 'task not found');
    }
    m = path.match(/^\/v1\/tasks\/([^/]+)\/messages$/);
    if (m) {
      if (!taskApi) return problem(404, 'not_found', 'resource not found');
      const tid = decodeURIComponent(m[1]);
      if (!tasks[tid]) return problem(404, 'not_found', 'task not found');
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const after = url.searchParams.get('cursor') ? Number(Buffer.from(url.searchParams.get('cursor'), 'base64url').toString()) : 0;
      const all = transcript.filter((t) => t.task_id === tid && t.seq > after).sort((a, b) => a.seq - b.seq);
      const page = all.slice(0, limit);
      const next = all.length > limit ? Buffer.from(String(page[page.length - 1].seq)).toString('base64url') : undefined;
      return json(200, { messages: page, ...(next ? { next_cursor: next } : {}) });
    }
    return problem(404, 'not_found', `fake multica has no ${path}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    server, port, baseUrl: `http://127.0.0.1:${port}`, requests,
    async stop() { await new Promise((r) => server.close(r)); },
  };
}

export const FIXTURE_WS = '11111111-1111-1111-1111-111111111111';
export const FIXTURE_WS2 = '66666666-6666-6666-6666-666666666666';
export const FIXTURE_ISSUE_ID = '22222222-2222-2222-2222-222222222222';
export const FIXTURE_ISSUE2_ID = '77777777-7777-7777-7777-777777777777';
export const FIXTURE_AGENT_A = '33333333-3333-3333-3333-333333333333';
export const FIXTURE_AGENT_B = '44444444-4444-4444-4444-444444444444';
export const FIXTURE_USER = '55555555-5555-5555-5555-555555555555';
export const FIXTURE_INSTALLATION = '88888888-8888-8888-8888-888888888888';
export const FIXTURE_INSTALLATION2 = '99999999-9999-9999-9999-999999999999';

export function fixtureIssue(overrides = {}) {
  return {
    id: FIXTURE_ISSUE_ID,
    workspace_id: FIXTURE_WS,
    identifier: 'MUL-7',
    title: '为消息推送服务选型并给出迁移方案',
    description: '对比 Kafka 与 RocketMQ,考虑顺序性、死信队列与客户端生态。预算上限 ¥5000/月,需要灰度方案。',
    status: 'todo',
    ...overrides,
  };
}

export function fixtureTranscript({ taskId }) {
  const t = [];
  let seq = 0;
  const push = (msg) => t.push({ task_id: taskId, created_at: new Date().toISOString(), ...msg });
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

/** A task as multica's GET /v1/tasks/{id} describes it. */
export function fixtureTask({ taskId, agentId = FIXTURE_AGENT_A, kind = 'issue', issueId = FIXTURE_ISSUE_ID, ...rest } = {}) {
  return {
    id: taskId, workspace_id: FIXTURE_WS, agent_id: agentId, kind, status: 'completed',
    issue_id: kind === 'issue' ? issueId : null,
    chat_session_id: null, chat_user_id: null, autopilot_id: null, autopilot_run_id: null,
    originator_user_id: FIXTURE_USER, trigger_comment_id: null, trigger_summary: null,
    delegated_from_task_id: null, delegated_from_agent_id: null, retry_of_task_id: null,
    attempt: 1, max_attempts: 2, failure_reason: null, input: [], created_at: new Date().toISOString(),
    started_at: null, completed_at: null,
    ...rest,
  };
}

/** A multica hook body. input for comment.created follows the real payload shape. */
export function hookBody({ eventType, hookKey = 'memory-archive', trigger = 'event', input, callbackUrl, invocationId = `inv-${randomUUID()}`, workspaceId = FIXTURE_WS, installationId = FIXTURE_INSTALLATION, actor, extra = {} } = {}) {
  return {
    version: 1,
    invocation_id: invocationId,
    attempt: 1,
    occurred_at: new Date().toISOString(),
    hook_key: hookKey,
    trigger,
    ...(eventType ? { event_type: eventType } : {}),
    workspace_id: workspaceId,
    installation_id: installationId,
    actor: actor ?? (trigger === 'event' ? { type: 'plugin', id: installationId } : { type: 'agent', id: FIXTURE_AGENT_A }),
    input,
    config: {},
    callback_token: 'mpc_testtoken',
    callback_url: callbackUrl,
    ...extra,
  };
}

/** comment.created input exactly as multica publishes it. */
export function commentEvent({ id = `cm-${randomUUID().slice(0, 8)}`, issueId = FIXTURE_ISSUE_ID, content, authorType = 'member', authorId = FIXTURE_USER, sourceTaskId } = {}) {
  return {
    comment: {
      id, issue_id: issueId, author_type: authorType, author_id: authorId, content, type: 'comment',
      parent_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), revision: 1,
      ...(sourceTaskId ? { source_task_id: sourceTaskId } : {}), reactions: [], attachments: [],
    },
    issue_title: '为消息推送服务选型并给出迁移方案', issue_assignee_type: 'agent', issue_assignee_id: FIXTURE_AGENT_A, issue_status: 'todo',
  };
}

/** task.completed / task.failed input exactly as multica publishes it. */
export function taskEvent({ taskId, agentId = FIXTURE_AGENT_A, issueId = FIXTURE_ISSUE_ID, status = 'completed', chatSessionId, ...extra } = {}) {
  return {
    task_id: taskId, agent_id: agentId, issue_id: issueId ?? '', status,
    ...(chatSessionId ? { chat_session_id: chatSessionId } : {}),
    ...extra,
  };
}
