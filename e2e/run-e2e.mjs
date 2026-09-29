#!/usr/bin/env node
/**
 * End-to-end verification against a REAL OpenViking instance (LLM extraction
 * and semantic search included) plus a simulated multica side (signed hook
 * deliveries + callback API). Everything the plugin does is real; only the
 * multica frontend/backend is simulated, byte-compatible with its contract.
 *
 * Usage:
 *   OV_VLM_KEY=... OV_EMBED_KEY=... node e2e/run-e2e.mjs
 * Keys can be sourced from an existing OV instance:
 *   see e2e/README.md (they are never written into the repo).
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
    id: ISSUE_ID, identifier: 'MUL-E2E', status: 'open',
    title: '消息推送服务选型与灰度迁移方案',
    description: '对比 Kafka 与 RocketMQ,评估顺序性保证、死信队列、事务消息与客户端生态。预算上限 ¥5000/月,需要可回滚的灰度方案。',
  };
  const transcript = [];
  let seq = 0;
  const push = (m) => transcript.push({ task_id: TASK_ID, issue_id: ISSUE_ID, created_at: new Date().toISOString(), ...m });
  push({ seq: ++seq, type: 'thinking', content: '需要先确认顺序性和事务消息的硬性要求。' });
  push({ seq: ++seq, type: 'text', content: '我将从顺序性、事务消息、死信队列和生态四个维度对比两个候选。' });
  push({ seq: ++seq, type: 'tool_use', tool: 'web_search', call_id: 'c1', input: { query: 'rocketmq transactional message ordering' } });
  push({ seq: ++seq, type: 'tool_result', tool: 'web_search', call_id: 'c1', output: 'RocketMQ 提供队列级顺序 + 事务消息 + 定时消息;Kafka 仅有分区内顺序,事务面向流处理。' });
  push({ seq: ++seq, type: 'tool_use', tool: 'multica', call_id: 'c2', input: { cmd: ['issue', 'list'] } });
  push({ seq: ++seq, type: 'tool_result', tool: 'multica', call_id: 'c2', output: 'MUL-1..MUL-9 (probe output)' });
  push({ seq: ++seq, type: 'text', content: '# Multica Agent Runtime\n(运行时简报,不应进入蒸馏输入)' });
  push({ seq: ++seq, type: 'text', content: '最终结论:推荐 RocketMQ。理由:(1) 队列级顺序满足订单场景;(2) 事务消息原生支持,无需双写中间表;(3) 死信队列与重试策略完善;(4) Java/Go 客户端生态完整。预算估算 ¥3800/月,在限额内。灰度方案:先双写两周,按订单号尾号 5% 灰度消费,回滚只需切回旧消费者。' });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mc');
    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer mpc_')) {
      return json(401, { error: { code: 'plugin_bearer_required', message: 'callback token required' } });
    }
    const p = url.pathname;
    if (p === '/v1/context') return json(200, { workspace: { id: WS, name: 'e2e' }, actor: { type: 'plugin' }, config: {} });
    if (p === `/v1/issues/${ISSUE_ID}`) return json(200, issue);
    if (p === `/v1/issues/${ISSUE_ID}/comments`) return json(200, { comments: [] });
    if (p === `/v1/tasks/${TASK_ID}/messages`) {
      const since = Number(url.searchParams.get('since') ?? 0);
      const include = url.searchParams.get('include') ?? '';
      const msgs = transcript.filter((m) => m.seq > since && (include.includes('thinking=false') ? m.type !== 'thinking' : true));
      return json(200, { messages: msgs });
    }
    return json(404, { error: { code: 'not_found', message: p } });
  });
  await new Promise((r) => server.listen(MC_PORT, '127.0.0.1', r));
  return { server };
}

// ---------------------------------------------------------------------------
async function main() {
  if (!process.env.OV_VLM_KEY || !process.env.OV_EMBED_KEY) {
    console.error('need OV_VLM_KEY and OV_EMBED_KEY (see e2e/README.md)');
    process.exit(2);
  }

  // 1. boot / reuse the real OV instance
  const ovBase = `http://127.0.0.1:${OV_PORT}`;
  let health = null;
  try { health = await jfetch(`${ovBase}/health`); } catch { /* not up */ }
  if (!health || health.status !== 200) {
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
      return r.json?.result?.memories ?? [];
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
    if (r1.status !== 200 || r1.json?.result?.status !== 'queued') throw new Error(`S1 delivery failed: ${r1.status} ${r1.text}`);
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
      const hits = await ovSearch(key, '消息推送服务选型 RocketMQ 结论');
      const good = hits.filter((x) => x.context_type === 'memory' && !/\.overview\.md$/.test(x.uri));
      return good.length ? good : null;
    }, { timeoutMs: 300_000 });
    step('S1 task run archived → distilled → semantic recall hit', true,
      `${hit.length} memories, top=${hit[0]?.uri?.split('/').pop()} score=${hit[0]?.score} in ${Math.round((Date.now() - t0) / 1000)}s`);

    // the distilled memory must carry the business conclusion, not the runtime brief or probe
    const contentR = await jfetch(`${ovBase}/api/v1/content/read?uri=${encodeURIComponent(hit[0].uri)}&offset=1&limit=500`, {
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
        actor: { type: 'agent', id: AGENT_A }, input: { query: '消息推送服务怎么选型的?', issue_id: ISSUE_ID }, config: {},
      });
      entries = rr.json?.result?.entries ?? [];
      s3detail = `status=${rr.status} entries=${entries.length} scopesSearched=${JSON.stringify(rr.json?.result?.scopesSearched ?? null)}`;
      if (!entries.length) await sleep(5_000);
    }
    step('S3 agent memory-recall returns scoped entries with sources', entries.length > 0,
      entries.length
        ? `entries=${entries.length} scopes=${[...new Set(entries.map((e) => e.scope.split(':')[0]))].join(',')}`
        : s3detail);

    // ---- S4: agent remember tool → own public space, searchable
    const rem = await signAndPost('/hooks/memory-remember', {
      version: 1, invocation_id: 'e2e-rem-1', attempt: 1, occurred_at: new Date().toISOString(),
      hook_key: 'memory-remember', trigger: 'agent', workspace_id: WS, installation_id: 'inst-e2e',
      actor: { type: 'agent', id: AGENT_A },
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
      comment: { id: 'e2e-comment-1', issue_id: ISSUE_ID, content: '死信队列的监控告警要求补充进方案,峰值堆积阈值 1 万条。', author: { id: USER_1, name: 'cloud' }, created_at: new Date().toISOString() },
      issue_title: '消息推送服务选型与灰度迁移方案', issue_assignee_type: 'agent', issue_assignee_id: AGENT_A, issue_status: 'open',
    }));
    if (rc.status !== 200) throw new Error(`comment delivery failed: ${rc.text}`);
    await waitFor('comment feedback distilled', async () => {
      const hits = await ovSearch(keyOf(taskScope), '死信队列 监控 告警 阈值');
      return hits.length ? hits : null;
    }, { timeoutMs: 240_000 });
    step('S5 human comment archived with attribution and distilled', true);

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
    });
    const bEntries = rb.json?.result?.entries ?? [];
    step('S8 agent B recall does not surface agent A memories', !bEntries.some((e) => e.scope === agentScopeA),
      `bEntries=${bEntries.length} scopes=${[...new Set(bEntries.map((e) => e.scope))].join(',') || '(none)'}`);

    // ---- S9: redelivery dedupe
    const dupBody = ev('task.completed', { task_id: TASK_ID, agent_id: AGENT_A, issue_id: ISSUE_ID, status: 'completed' }, { invocation_id: 'e2e-dup-1' });
    const d1 = await signAndPost('/hooks/memory-archive', dupBody);
    const d2 = await signAndPost('/hooks/memory-archive', dupBody);
    step('S9 duplicate delivery is a ledger no-op', d1.json?.result?.status === 'queued' && d2.json?.result?.status === 'duplicate');

    // ---- S10: status surfaces
    const st = await signAndPost('/hooks/memory-status', {
      version: 1, invocation_id: 'e2e-st-1', attempt: 1, occurred_at: new Date().toISOString(),
      hook_key: 'memory-status', trigger: 'agent', workspace_id: WS, installation_id: 'inst-e2e',
      actor: { type: 'agent', id: AGENT_A }, input: {}, config: {},
    });
    const s = st.json?.result;
    step('S10 memory-status reports health, queue and archives',
      st.status === 200 && s?.openviking?.healthy === true && s?.archive_queue?.done >= 3,
      `done=${s?.archive_queue?.done} scopes=${s?.scopes?.scopes}`);

    // ---- S11: admin status (bearer)
    const adm = await jfetch(`http://127.0.0.1:${PLUGIN_PORT}/admin/status`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    step('S11 admin status endpoint', adm.status === 200 && adm.json?.result?.scopes?.scopes >= 3, `scopes=${adm.json?.result?.scopes?.scopes}`);

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
