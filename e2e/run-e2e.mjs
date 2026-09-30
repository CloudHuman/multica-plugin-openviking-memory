#!/usr/bin/env node
/**
 * End-to-end verification against a REAL OpenViking instance (LLM extraction
 * and semantic search included) plus a simulated multica side (signed hook
 * deliveries + callback API). Everything the plugin does is real; only the
 * multica frontend/backend is simulated, byte-compatible with its contract.
 *
 *   E2E_MULTICA=patched (default)  multica with the task read API
 *                                  (GET /v1/tasks/{id}[/messages], upstream/multica)
 *   E2E_MULTICA=stock              multica v0.6 as released: no task API, so a
 *                                  run is archived through the comment it posts
 *
 * Usage (reusing a running OV on OV_E2E_PORT needs no keys):
 *   OV_VLM_KEY=... OV_EMBED_KEY=... node e2e/run-e2e.mjs
 * Keys can be sourced from an existing OV instance:
 *   see e2e/README.md (they are never written into the repo).
 * For the same scenarios against a REAL multica, see e2e/real-stack/.
 */
import { spawn } from 'node:child_process';
import { randomBytes, createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OV_PORT = process.env.OV_E2E_PORT ?? '1936';
const PLUGIN_PORT = Number(process.env.OVMEM_E2E_PLUGIN_PORT ?? 18790);
const MC_PORT = Number(process.env.OVMEM_E2E_MC_PORT ?? 18081);
// Root key: explicit env wins; else reuse the key recorded by ov-boot.sh for
// the running instance (reruns MUST NOT mint a fresh key against an existing
// container, or provisioning 401s); else random for a fresh boot.
function resolveRootKey() {
  if (process.env.OV_ROOT_KEY) return process.env.OV_ROOT_KEY;
  try {
    return readFileSync(join(tmpdir(), 'ovmem-e2e-root-key'), 'utf8').trim();
  } catch {
    return randomBytes(32).toString('hex');
  }
}
const OV_ROOT_KEY = resolveRootKey();
const SIGNING_SECRET = 'whsec_' + randomBytes(32).toString('hex');
const ADMIN_TOKEN = 'e2e-admin-' + randomBytes(8).toString('hex');

// Re-runs get their own identifier universe (scopes, sessions, ledger), so a
// rerun never collides with a previous run's archived memories.
const RUN = process.env.E2E_RUN_ID ?? Date.now().toString(36);
const MULTICA = process.env.E2E_MULTICA === 'stock' ? 'stock' : 'patched';
const WS = `e2ews-${RUN}`;
const ISSUE_ID = `e2eissue-${RUN}`;
const AGENT_A = `e2eagenta-${RUN}`;
const AGENT_B = `e2eagentb-${RUN}`;
const USER_1 = `e2euser-${RUN}`;
const TASK_ID = `e2etask-${RUN}`;

const results = [];
function step(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, fn, { timeoutMs = 240_000, intervalMs = 4_000 } = {}) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      if (err?.fatal) throw err;
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`waitFor(${label}) timed out${lastErr ? `; last error: ${lastErr.message}` : ''}`);
}

async function jfetch(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, json, text };
}

async function signAndPost(path, bodyObj) {
  const raw = JSON.stringify(bodyObj);
  const ts = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(SIGNING_SECRET.slice(6), 'hex');
  const sig = createHmac('sha256', key).update(ts).update('.').update(raw).digest('hex');
  const res = await fetch(`http://127.0.0.1:${PLUGIN_PORT}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Multica-Timestamp': ts,
      'X-Multica-Signature': `v1=${sig}`,
      'X-Multica-Plugin-Installation': 'inst-e2e',
    },
    body: raw,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, json, text };
}

// ---------------------------------------------------------------------------
// simulated multica callback API
// ---------------------------------------------------------------------------
async function startFakeMultica() {
  const { createServer } = await import('node:http');
  const issue = {
    id: ISSUE_ID, workspace_id: WS, identifier: 'MUL-E2E', status: 'todo',
    title: '消息推送服务选型与灰度迁移方案',
    description: '对比 Kafka 与 RocketMQ,评估顺序性保证、死信队列、事务消息与客户端生态。预算上限 ¥5000/月,需要可回滚的灰度方案。',
  };
  // GET /v1/tasks/{id} as the task read API describes a run.
  const task = {
    id: TASK_ID, workspace_id: WS, agent_id: AGENT_A, kind: 'issue', status: 'completed', issue_id: ISSUE_ID,
    chat_session_id: null, chat_user_id: null, autopilot_id: null, originator_user_id: USER_1,
    trigger_comment_id: 'e2e-trigger', delegated_from_agent_id: null,
    input: [{ source: 'comment', author_type: 'member', author_id: USER_1, content: '请给出消息推送服务的选型结论和灰度方案。' }],
  };
  const transcript = [];
  let seq = 0;
  const push = (m) => transcript.push({ task_id: TASK_ID, created_at: new Date().toISOString(), ...m });
  push({ seq: ++seq, type: 'thinking', content: '需要先确认顺序性和事务消息的硬性要求。' });
  push({ seq: ++seq, type: 'text', content: '我将从顺序性、事务消息、死信队列和生态四个维度对比两个候选。' });
  push({ seq: ++seq, type: 'tool_use', tool: 'web_search', call_id: 'c1', input: { query: 'rocketmq transactional message ordering' } });
  push({ seq: ++seq, type: 'tool_result', tool: 'web_search', call_id: 'c1', output: 'RocketMQ 提供队列级顺序 + 事务消息 + 定时消息;Kafka 仅有分区内顺序,事务面向流处理。' });
  push({ seq: ++seq, type: 'tool_use', tool: 'multica', call_id: 'c2', input: { cmd: ['issue', 'list'] } });
  push({ seq: ++seq, type: 'tool_result', tool: 'multica', call_id: 'c2', output: 'MUL-1..MUL-9 (probe output)' });
  push({ seq: ++seq, type: 'text', content: '# Multica Agent Runtime\n(运行时简报,不应进入蒸馏输入)' });
  push({ seq: ++seq, type: 'text', content: FINAL_CONCLUSION });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mc');
    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const problem = (status, code, detail) => json(status, { type: `urn:multica:problem:${code}`, title: code, status, code, detail });
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer mpc_')) return problem(401, 'unauthorized', 'callback token required');
    const p = url.pathname;
    if (p === '/v1/context') return json(200, { workspace: { id: WS, name: 'e2e', slug: 'e2e' }, actor: 'plugin', config: {}, granted_net_domains: [] });
    if (p === `/v1/issues/${ISSUE_ID}` || p === '/v1/issues/MUL-E2E') return json(200, issue);
    if (p.startsWith('/v1/tasks/') && MULTICA === 'stock') return problem(404, 'not_found', 'resource not found');
    if (p === `/v1/tasks/${TASK_ID}`) return json(200, task);
    if (p === `/v1/tasks/${TASK_ID}/messages`) {
      const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 50));
      const cursor = url.searchParams.get('cursor');
      const after = cursor ? Number(Buffer.from(cursor, 'base64url').toString()) : 0;
      const rest = transcript.filter((m) => m.seq > after);
      const page = rest.slice(0, limit);
      const next = rest.length > limit ? Buffer.from(String(page.at(-1).seq)).toString('base64url') : undefined;
      return json(200, { messages: page, ...(next ? { next_cursor: next } : {}) });
    }
    return problem(404, 'not_found', p);
  });
  await new Promise((r) => server.listen(MC_PORT, '127.0.0.1', r));
  return { server };
}

const FINAL_CONCLUSION = '最终结论:推荐 RocketMQ。理由:(1) 队列级顺序满足订单场景;(2) 事务消息原生支持,无需双写中间表;(3) 死信队列与重试策略完善;(4) Java/Go 客户端生态完整。预算估算 ¥3800/月,在限额内。灰度方案:先双写两周,按订单号尾号 5% 灰度消费,回滚只需切回旧消费者。';

// ---------------------------------------------------------------------------
async function main() {
  console.log(`multica contract: ${MULTICA}`);
  // 1. boot / reuse the real OV instance
  const ovBase = `http://127.0.0.1:${OV_PORT}`;
  let health = null;
  try { health = await jfetch(`${ovBase}/health`); } catch { /* not up */ }
  if (!health || health.status !== 200) {
    if (!process.env.OV_VLM_KEY || !process.env.OV_EMBED_KEY) {
      console.error(`no OpenViking on :${OV_PORT}; booting one needs OV_VLM_KEY and OV_EMBED_KEY (see e2e/README.md)`);
      process.exit(2);
    }
    console.log('booting disposable OpenViking instance…');
    const boot = spawn('bash', [join(root, 'e2e', 'ov-boot.sh')], {
      env: { ...process.env, OV_ROOT_KEY, OV_PORT_E2E: OV_PORT, OV_E2E_PORT: OV_PORT },
      stdio: 'inherit',
    });
    const code = await new Promise((r) => boot.once('exit', r));
    if (code !== 0) throw new Error('ov-boot.sh failed');
  }
  const h = await waitFor('ov /health', async () => {
    const r = await jfetch(`${ovBase}/health`).catch(() => null);
    return r && r.status === 200 ? r : null;
  }, { timeoutMs: 180_000 });
  console.log(`OpenViking up: version=${h.json?.version} auth=${h.json?.auth_mode}`);

  // 2. start the plugin service
  const stateDir = mkdtempSync(join(tmpdir(), 'ovmem-e2e-'));
  const pluginLog = [];
  const plugin = spawn(process.execPath, [join(root, 'src', 'server.mjs')], {
    env: {
      ...process.env,
      OVMEM_PORT: String(PLUGIN_PORT),
      OVMEM_BIND: '127.0.0.1',
      OVMEM_STATE_DIR: stateDir,
      OVMEM_OV_BASE_URL: ovBase,
      OVMEM_OV_ROOT_KEY: OV_ROOT_KEY,
      OVMEM_SIGNING_SECRET: SIGNING_SECRET,
      OVMEM_PLUGIN_TOKEN: ADMIN_TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  plugin.stdout.on('data', (d) => pluginLog.push(d.toString()));
  plugin.stderr.on('data', (d) => pluginLog.push(d.toString()));
  const mc = await startFakeMultica();

  const cleanup = async () => {
    plugin.kill('SIGTERM');
    await new Promise((r) => mc.server.close(r));
  };
  const fail = async (name, err) => {
    step(name, false, err.message);
    console.error(pluginLog.join('').slice(-4000));
    await cleanup();
    process.exit(1);
  };

  try {
    await waitFor('plugin /healthz', async () => {
      const r = await jfetch(`http://127.0.0.1:${PLUGIN_PORT}/healthz`).catch(() => null);
      return r && r.status === 200 && r.json?.result?.ov?.healthy ? r : null;
    }, { timeoutMs: 60_000 });
    step('S0 plugin boots and reports OV healthy', true);

    const readScopesState = () => JSON.parse(readFileSync(join(stateDir, 'scopes.json'), 'utf8'));
    const keyOf = (scopeKey) => readScopesState().scopes[scopeKey]?.apiKey;
    const ovSearch = async (key, query) => {
      const r = await jfetch(`${ovBase}/api/v1/search/search`, {
        method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: { query, mode: 'list', limit: 10 },
      });
      // Directory summaries (.overview.md / .abstract.md) are searchable too; a
      // step passes only on a real memory.
      return (r.json?.result?.memories ?? []).filter((m) => m.context_type === 'memory' && !/\/\.(overview|abstract)\.md$/.test(m.uri));
    };

    // ---- S1: task.completed → real archive → real LLM extraction → searchable memory
    const ev = (eventType, input, extra = {}) => ({
      version: 1, invocation_id: `e2e-${Math.random().toString(36).slice(2, 10)}`, attempt: 1,
      occurred_at: new Date().toISOString(), hook_key: 'memory-archive', trigger: 'event',
      event_type: eventType, workspace_id: WS, installation_id: 'inst-e2e', issue_id: ISSUE_ID,
      actor: { type: 'member', id: USER_1 }, input, config: {},
      callback_token: 'mpc_e2e', callback_url: `http://127.0.0.1:${MC_PORT}/v1`, ...extra,
    });
    const t0 = Date.now();
    const r1 = await signAndPost('/hooks/memory-archive', ev('task.completed', {
      task_id: TASK_ID, agent_id: AGENT_A, issue_id: ISSUE_ID, status: 'completed',
    }));
    if (MULTICA === 'patched') {
      if (r1.status !== 200 || r1.json?.result?.status !== 'queued' || r1.json.result.completeness !== 'complete') {
        throw new Error(`S1 delivery failed: ${r1.status} ${r1.text}`);
      }
    } else {
      // Stock multica cannot hand the transcript over: the run is skipped with a
      // 200 (no breaker trip), and its visible outcome arrives as its comment.
      step('S1a stock multica: run event skipped with 200, not archived as noise',
        r1.status === 200 && r1.json?.result?.status === 'skipped', r1.json?.result?.reason ?? r1.text);
      const rc0 = await signAndPost('/hooks/memory-archive', ev('comment.created', {
        comment: {
          id: 'e2e-agent-reply', issue_id: ISSUE_ID, author_type: 'agent', author_id: AGENT_A, content: FINAL_CONCLUSION,
          type: 'comment', parent_id: null, source_task_id: TASK_ID, created_at: new Date().toISOString(), reactions: [], attachments: [],
        },
        issue_title: '消息推送服务选型与灰度迁移方案', issue_assignee_type: 'agent', issue_assignee_id: AGENT_A, issue_status: 'todo',
      }));
      if (rc0.json?.result?.status !== 'queued') throw new Error(`S1 agent comment failed: ${rc0.text}`);
    }
    const taskScope = `task:${WS}:${ISSUE_ID}`;
    const hit = await waitFor('extraction produces searchable memory', async () => {
      // Fail fast if the archive job itself died (e.g. provisioning auth).
      const adm = await jfetch(`http://127.0.0.1:${PLUGIN_PORT}/admin/status`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }).catch(() => null);
      const dead = adm?.json?.result?.queue_recent?.find((j) => j.status === 'failed');
      if (dead) {
        const e = new Error(`archive job failed permanently: ${dead.last_error}`);
        e.fatal = true;
        throw e;
      }
      const key = keyOf(taskScope);
      if (!key) return null;
      // Terms of the conclusion itself: a distilled memory may drop the lead-in.
      const hits = await ovSearch(key, '消息推送 选型 队列级顺序 事务消息 灰度');
      return hits.length ? hits : null;
    }, { timeoutMs: 300_000 });
    step(MULTICA === 'patched' ? 'S1 task run archived → distilled → semantic recall hit' : 'S1 agent reply archived → distilled → semantic recall hit', true,
      `${hit.length} memories, top=${hit[0]?.uri?.split('/').pop()} score=${hit[0]?.score} in ${Math.round((Date.now() - t0) / 1000)}s`);

    // the distilled memory must carry the business conclusion, not the runtime brief or probe
    const contentR = await jfetch(`${ovBase}/api/v1/content/read?uri=${encodeURIComponent(hit[0].uri)}&offset=0&limit=500`, {
      headers: { Authorization: `Bearer ${keyOf(taskScope)}` },
    });
    const rawResult = contentR.json?.result;
    const body = typeof rawResult === 'string' ? rawResult : rawResult?.content ?? '';
    const cleanBody = /RocketMQ|顺序|事务/.test(body) && !body.includes('Multica Agent Runtime') && !body.includes('issue list');
    step('S2 distilled memory carries the business conclusion (no brief/probe)', cleanBody, body.slice(0, 120).replace(/\n/g, ' '));

    // ---- S3: agent recall tool (signed agent trigger), retried across transient retrieval noise
    const agentScopeA = `agent:${WS}:${AGENT_A}`;
    let entries = [];
    let s3detail = '';
    for (let attempt = 1; attempt <= 3 && !entries.length; attempt++) {
      const rr = await signAndPost('/hooks/memory-recall', {
        version: 1, invocation_id: `e2e-recall-${attempt}`, attempt: 1, occurred_at: new Date().toISOString(),
        hook_key: 'memory-recall', trigger: 'agent', workspace_id: WS, installation_id: 'inst-e2e',
        actor: { type: 'agent', id: AGENT_A }, input: { query: '消息推送服务怎么选型的?', issue_id: 'MUL-E2E' }, config: {},
        callback_token: 'mpc_e2e', callback_url: `http://127.0.0.1:${MC_PORT}/v1`,
        // patched multica tells the plugin which run is calling
        ...(MULTICA === 'patched' ? { task_id: TASK_ID, issue_id: ISSUE_ID } : {}),
      });
      entries = rr.json?.result?.entries ?? [];
      s3detail = `status=${rr.status} bound=${rr.json?.result?.run?.bound} entries=${entries.length} scopesSearched=${JSON.stringify(rr.json?.result?.scopesSearched ?? null)}`;
      if (!entries.length) await sleep(5_000);
    }
    step('S3 agent memory-recall returns scoped entries with sources', entries.length > 0,
      entries.length
        ? `entries=${entries.length} bound=${MULTICA === 'patched'} scopes=${[...new Set(entries.map((e) => e.scope.split(':')[0]))].join(',')}`
        : s3detail);

    // ---- S4: agent remember tool → own public space, searchable
    const rem = await signAndPost('/hooks/memory-remember', {
      version: 1, invocation_id: 'e2e-rem-1', attempt: 1, occurred_at: new Date().toISOString(),
      hook_key: 'memory-remember', trigger: 'agent', workspace_id: WS, installation_id: 'inst-e2e',
      actor: { type: 'agent', id: AGENT_A },
      callback_token: 'mpc_e2e', callback_url: `http://127.0.0.1:${MC_PORT}/v1`,
      input: { title: '选型对比模板', content: '做中间件选型时,按 顺序性/事务/死信/生态/成本 五维对比,并给出灰度与回滚方案。', kind: 'experiences' },
      config: {},
    });
    if (rem.status !== 200) throw new Error(`remember failed: ${rem.text}`);
    await waitFor('remember searchable in agent space', async () => {
      const key = keyOf(agentScopeA);
      if (!key) return null;
      const hits = await ovSearch(key, '中间件选型 对比 模板');
      return hits.length ? hits : null;
    }, { timeoutMs: 120_000 });
    step('S4 memory-remember lands in THIS agent public space', !keyOf(`agent:${WS}:${AGENT_B}`),
      'agent-B space not provisioned (no path to it)');

    // ---- S5: comment.created → attributed feedback archived
    const rc = await signAndPost('/hooks/memory-archive', ev('comment.created', {
      comment: {
        id: 'e2e-comment-1', issue_id: ISSUE_ID, author_type: 'member', author_id: USER_1, type: 'comment', parent_id: null,
        content: '死信队列的监控告警要求补充进方案,峰值堆积阈值 1 万条。', created_at: new Date().toISOString(), reactions: [], attachments: [],
      },
      issue_title: '消息推送服务选型与灰度迁移方案', issue_assignee_type: 'agent', issue_assignee_id: AGENT_A, issue_status: 'todo',
    }));
    if (rc.status !== 200 || rc.json?.result?.status !== 'queued') throw new Error(`comment delivery failed: ${rc.text}`);
    // The comment's own fact (the 10k threshold) must be in a distilled memory,
    // not merely some memory that mentions dead-letter queues.
    const s5 = await waitFor('comment feedback distilled', async () => {
      const hits = await ovSearch(keyOf(taskScope), '死信队列 监控 告警 阈值');
      for (const h of hits) {
        const r = await jfetch(`${ovBase}/api/v1/content/read?uri=${encodeURIComponent(h.uri)}&offset=0&limit=200`, { headers: { Authorization: `Bearer ${keyOf(taskScope)}` } });
        const text = typeof r.json?.result === 'string' ? r.json.result : '';
        if (/1\s*万|10,?000|一万/.test(text)) return h;
      }
      return null;
    }, { timeoutMs: 240_000 }).catch(() => null);
    step('S5 human comment archived with attribution and distilled', Boolean(s5), s5 ? s5.uri.split('/').slice(-3).join('/') : 'no memory carries the comment\'s threshold');

    // ---- S6: companion chat → DM pair space, hard isolation
    const chat = await jfetch(`http://127.0.0.1:${PLUGIN_PORT}/internal/events`, {
      method: 'POST', headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: {
        type: 'chat.completed', version: 1, workspace_id: WS, delivery_id: 'e2e-chat-1',
        payload: {
          chat_ref: 'e2e-chat-42', agent_id: AGENT_A, user_id: USER_1,
          messages: [
            { role: 'user', content: '记住:这个项目的所有代码注释一律使用中文,API 命名保持驼峰。' },
            { role: 'assistant', content: '明白,后续输出我会遵循这个约定。' },
          ],
        },
      },
    });
    if (chat.status !== 200) throw new Error(`chat delivery failed: ${chat.text}`);
    const dmScope = `dm:${WS}:${AGENT_A}:${USER_1}`;
    await waitFor('dm chat archived', async () => (keyOf(dmScope) ? true : null));
    await waitFor('dm extraction', async () => {
      const hits = await ovSearch(keyOf(dmScope), '代码注释 中文 约定');
      return hits.length ? hits : null;
    }, { timeoutMs: 240_000 });
    step('S6 DM chat archived into pair space and distilled', true);

    // isolation: the DM-pair key cannot read the task collaboration space
    const crossRead = await jfetch(`${ovBase}/api/v1/content/read?uri=${encodeURIComponent(hit[0].uri)}`, {
      headers: { Authorization: `Bearer ${keyOf(dmScope)}` },
    });
    step('S7 cross-scope read rejected by OpenViking (structural isolation)', crossRead.status === 403 || crossRead.status === 404,
      `status=${crossRead.status}`);

    // agent B recall must not see A's public memory
    const rb = await signAndPost('/hooks/memory-recall', {
      version: 1, invocation_id: 'e2e-recall-b', attempt: 1, occurred_at: new Date().toISOString(),
      hook_key: 'memory-recall', trigger: 'agent', workspace_id: WS, installation_id: 'inst-e2e',
      actor: { type: 'agent', id: AGENT_B }, input: { query: '中间件选型 对比 模板' }, config: {},
      callback_token: 'mpc_e2e', callback_url: `http://127.0.0.1:${MC_PORT}/v1`,
    });
    const bEntries = rb.json?.result?.entries ?? [];
    step('S8 agent B recall does not surface agent A memories', !bEntries.some((e) => e.scope === agentScopeA),
      `bEntries=${bEntries.length} scopes=${[...new Set(bEntries.map((e) => e.scope))].join(',') || '(none)'}`);

    // ---- S9: redelivery dedupe — multica retries under a NEW invocation id
    const redelivery = (invocationId) => ev('comment.created', {
      comment: {
        id: 'e2e-comment-1', issue_id: ISSUE_ID, author_type: 'member', author_id: USER_1, type: 'comment', parent_id: null,
        content: '死信队列的监控告警要求补充进方案,峰值堆积阈值 1 万条。', created_at: new Date().toISOString(), reactions: [], attachments: [],
      },
    }, { invocation_id: invocationId });
    const d1 = await signAndPost('/hooks/memory-archive', redelivery('e2e-dup-1'));
    const d2 = await signAndPost('/hooks/memory-archive', redelivery('e2e-dup-1'));
    step('S9 redelivered record is a duplicate (new or repeated invocation id)',
      d1.json?.result?.status === 'duplicate' && d2.json?.result?.status === 'duplicate',
      `new-invocation=${d1.json?.result?.status} same-invocation=${d2.json?.result?.status}`);

    // ---- S10: status surfaces (wait until every archive job AND its extraction
    // settles: the watcher polls OV with backoff, so it trails OV by a little)
    let s = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      const st = await signAndPost('/hooks/memory-status', {
        version: 1, invocation_id: `e2e-st-${attempt}`, attempt: 1, occurred_at: new Date().toISOString(),
        hook_key: 'memory-status', trigger: 'agent', workspace_id: WS, installation_id: 'inst-e2e',
        actor: { type: 'agent', id: AGENT_A }, input: {},
        callback_token: 'mpc_e2e', callback_url: `http://127.0.0.1:${MC_PORT}/v1`,
      });
      s = st.json?.result;
      const settled = (s?.archive_queue?.done ?? 0) >= 3 && !(s?.archive_queue?.running > 0) && !(s?.extraction?.pending > 0);
      if (st.status === 200 && s?.openviking?.healthy === true && settled) break;
      await sleep(5_000);
    }
    const extracted = (s?.recent_archives ?? []).filter((e) => e.type === 'extraction' && e.extraction === 'done').length;
    step('S10 memory-status reports health, queue and extraction per archive',
      (s?.archive_queue?.done ?? 0) >= 3 && !s?.archive_queue?.failed && !(s?.extraction?.pending > 0) && extracted >= 3,
      `queue=${JSON.stringify(s?.archive_queue)} extraction=${JSON.stringify(s?.extraction)} extracted=${extracted}`);

    // ---- S11: admin status (bearer)
    const adm = await jfetch(`http://127.0.0.1:${PLUGIN_PORT}/admin/status`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    step('S11 admin status endpoint', adm.status === 200 && adm.json?.result?.scopes?.scopes >= 3, `scopes=${adm.json?.result?.scopes?.scopes}`);

    // ---- S12: ov-* facade over OV's real /mcp, confined to the caller's own space
    const facade = (tool, input) => signAndPost(`/hooks/ov-${tool}`, {
      version: 1, invocation_id: `e2e-ov-${tool}-${Math.random().toString(36).slice(2, 8)}`, attempt: 1, occurred_at: new Date().toISOString(),
      hook_key: `ov-${tool}`, trigger: 'agent', workspace_id: WS, installation_id: 'inst-e2e',
      actor: { type: 'agent', id: AGENT_A }, input, config: {},
      callback_token: 'mpc_e2e', callback_url: `http://127.0.0.1:${MC_PORT}/v1`,
    });
    const own = await facade('find', { query: '中间件选型 对比 模板' });
    const shared = await facade('read', { uris: 'viking://resources' });
    const foreign = await facade('list', { uri: `viking://user/${readScopesState().scopes[taskScope]?.userId}` });
    step('S12 ov-* facade works in the own space and refuses shared/foreign URIs',
      own.json?.status === 'ok' && typeof own.json.result?.output === 'string'
        && shared.json?.error?.code === 'outside_own_space' && foreign.json?.error?.code === 'outside_own_space',
      `own=${own.json?.status} resources=${shared.json?.error?.code} other-user=${foreign.json?.error?.code}`);

    await cleanup();
    const failed = results.filter((r) => !r.ok);
    console.log(`\nE2E RESULT: ${results.length - failed.length}/${results.length} steps passed`);
    if (failed.length) {
      failed.forEach((f) => console.log(`  FAILED: ${f.name} — ${f.detail}`));
      process.exit(1);
    }
  } catch (err) {
    await fail('unexpected', err);
  }
}

main();
