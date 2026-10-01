#!/usr/bin/env node
/**
 * Real-stack end-to-end run: a REAL multica server (patched or stock), a REAL
 * OpenViking, and this plugin, wired the way a deployment wires them. Nothing
 * on the multica side is simulated: runs are driven through the daemon API an
 * agent runtime uses, agent tool calls go daemon → multica → signed hook, and
 * events are delivered by multica's own dispatcher (retries, breaker and all).
 *
 * The runner creates two workspaces, installs the plugin package in each,
 * starts the plugin service with the rotated signing secrets, then plays the
 * scenarios below and prints PASS/FAIL per step.
 *
 * The multica flavor is detected, not configured: a build with the task read
 * API (upstream/multica) accepts the package that asks for chats:read; stock
 * multica refuses it, and the plain package is used.
 *
 * Env (defaults match e2e/real-stack/README.md):
 *   MC_BASE=http://127.0.0.1:8080        multica API
 *   MC_DEV_CODE=888888                   MULTICA_DEV_VERIFICATION_CODE
 *   OV_BASE=http://127.0.0.1:1936        OpenViking
 *   OV_ROOT_KEY=…                        OpenViking root key (required)
 *   PLUGIN_URL=https://host.docker.internal:8790   must be in MULTICA_PLUGIN_DEV_ORIGINS
 *   OVMEM_TLS_CERT / OVMEM_TLS_KEY       server cert for PLUGIN_URL's host (required)
 *   PLUGIN_CA=…                          CA that signed it = MULTICA_PLUGIN_DEV_CA (required)
 *   MOCK_LLM_URL=http://127.0.0.1:18999  optional: enables the extraction-failure scenario
 *   REPORT_FILE=…                        optional: write the results as JSON
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Multica, sleep } from './multica.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = process.env;
const cfg = {
  mcBase: env.MC_BASE ?? 'http://127.0.0.1:8080',
  devCode: env.MC_DEV_CODE ?? '888888',
  ovBase: env.OV_BASE ?? 'http://127.0.0.1:1936',
  ovRootKey: env.OV_ROOT_KEY ?? '',
  pluginUrl: (env.PLUGIN_URL ?? 'https://host.docker.internal:8790').replace(/\/+$/, ''),
  tlsCert: env.OVMEM_TLS_CERT ?? '',
  tlsKey: env.OVMEM_TLS_KEY ?? '',
  pluginCa: env.PLUGIN_CA ?? '',
  mockLlm: (env.MOCK_LLM_URL ?? '').replace(/\/+$/, ''),
  report: env.REPORT_FILE ?? '',
};
for (const [k, v] of Object.entries({ OV_ROOT_KEY: cfg.ovRootKey, OVMEM_TLS_CERT: cfg.tlsCert, OVMEM_TLS_KEY: cfg.tlsKey, PLUGIN_CA: cfg.pluginCa })) {
  if (!v) {
    console.error(`${k} is required (see e2e/real-stack/README.md)`);
    process.exit(2);
  }
}
const pluginPort = Number(new URL(cfg.pluginUrl).port || 443);
const RUN = Date.now().toString(36);
const ADMIN_TOKEN = `e2e-admin-${randomUUID()}`;

const results = [];
function step(id, name, ok, detail = '') {
  results.push({ id, name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${name}${detail ? ` — ${detail}` : ''}`);
}
async function waitFor(label, fn, { timeoutMs = 120_000, intervalMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}
async function jfetch(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, json, text };
}

/** HTTPS to the plugin, trusting only the dev CA (no global env games). */
function pluginCall(path, { method = 'GET', headers = {}, raw } = {}) {
  const url = new URL(path, cfg.pluginUrl);
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      host: '127.0.0.1', servername: url.hostname, port: pluginPort, path: url.pathname, method,
      ca: readFileSync(cfg.pluginCa), headers: { ...(raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* raw */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (raw !== undefined) req.write(raw);
    req.end();
  });
}

/** A delivery signed exactly as multica signs one — with whatever secret the caller holds. */
function signedHook(hookKey, body, { secret, installation }) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'hex')).update(ts).update('.').update(raw).digest('hex');
  return pluginCall(`/hooks/${hookKey}`, {
    method: 'POST', raw,
    headers: { 'X-Multica-Timestamp': ts, 'X-Multica-Signature': `v1=${sig}`, 'X-Multica-Plugin-Installation': installation },
  });
}

function buildPackage({ chats }) {
  const out = execFileSync('bash', [join(root, 'scripts', 'package.sh'), '--url', cfg.pluginUrl, ...(chats ? ['--with-chats-read'] : [])], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const m = out.match(/packaged: (\S+\.zip)/);
  if (!m) throw new Error(`package.sh printed no package path:\n${out}`);
  return join(root, m[1]);
}

async function mockMode(mode) {
  if (!cfg.mockLlm) return null;
  const r = await jfetch(`${cfg.mockLlm}/mode`, { method: 'POST', body: { mode } });
  return r.json?.mode;
}

async function main() {
  const mc = new Multica({ base: cfg.mcBase, devCode: cfg.devCode });
  const mcHealth = await jfetch(`${cfg.mcBase}/health`).catch(() => null);
  const ovHealth = await jfetch(`${cfg.ovBase}/health`).catch(() => null);
  if (mcHealth?.status !== 200 || ovHealth?.status !== 200) {
    console.error(`multica ${mcHealth?.status ?? 'down'} / OpenViking ${ovHealth?.status ?? 'down'}: start both first`);
    process.exit(2);
  }
  await mockMode('write');

  // ---------------------------------------------------------------- setup
  const chatsZip = buildPackage({ chats: true });
  const plainZip = buildPackage({ chats: false });
  const u1 = await mc.login(`ovmem-e2e-${RUN}-a@example.com`);
  const u2 = await mc.login(`ovmem-e2e-${RUN}-b@example.com`);
  const ws1 = await mc.createWorkspace(u1.token, { name: `OV memory e2e ${RUN}`, slug: `ovmem-${RUN}-a`, prefix: 'OVA' });
  const ws2 = await mc.createWorkspace(u2.token, { name: `OV memory e2e ${RUN} (tenant 2)`, slug: `ovmem-${RUN}-b`, prefix: 'OVB' });

  let flavor = 'patched';
  let pub1 = await mc.publishPlugin(u1.token, ws1, chatsZip);
  if (pub1.status >= 400) {
    if (!/chats:read|scope/i.test(pub1.text)) throw new Error(`publish refused: ${pub1.status} ${pub1.text.slice(0, 300)}`);
    flavor = 'stock';
    pub1 = await mc.publishPlugin(u1.token, ws1, plainZip);
  }
  if (pub1.status >= 300) throw new Error(`publish: ${pub1.status} ${pub1.text.slice(0, 300)}`);
  const zip = flavor === 'patched' ? chatsZip : plainZip;
  const pub2 = await mc.publishPlugin(u2.token, ws2, zip);
  if (pub2.status >= 300) throw new Error(`publish (ws2): ${pub2.status} ${pub2.text.slice(0, 300)}`);
  const versionOf = (p) => p.json.versions?.[0]?.id ?? p.json.version?.id ?? p.json.version_id;
  const inst1 = await mc.installPlugin(u1.token, ws1, versionOf(pub1));
  const inst2 = await mc.installPlugin(u2.token, ws2, versionOf(pub2));
  console.log(`multica flavor: ${flavor} (scopes granted: ${inst1.scopes.join(' ')})`);
  step('S0', `plugin package published and installed in two workspaces (${flavor} multica)`,
    Boolean(inst1.signingSecret && inst2.signingSecret), `ws1=${ws1} ws2=${ws2}`);

  // ---------------------------------------------------------------- plugin
  const stateDir = mkdtempSync(join(tmpdir(), 'ovmem-real-stack-'));
  // Faster extraction watching and re-drive than production, same code paths.
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ extractPollIntervalMs: 1500, extractPollMaxIntervalMs: 4000, extractRedriveDelayMs: 8000 }));
  const pluginLog = [];
  const plugin = spawn(process.execPath, [join(root, 'src', 'server.mjs')], {
    env: {
      PATH: env.PATH, HOME: env.HOME,
      OVMEM_PORT: String(pluginPort), OVMEM_BIND: '127.0.0.1', OVMEM_STATE_DIR: stateDir,
      OVMEM_OV_BASE_URL: cfg.ovBase, OVMEM_OV_ROOT_KEY: cfg.ovRootKey,
      // Installation 1 is pinned to its workspace in config; installation 2 is
      // bound by asking multica (GET /v1/context) on its first delivery.
      OVMEM_SIGNING_SECRETS: JSON.stringify({ [inst1.installationId]: { secret: inst1.signingSecret, workspace_id: ws1 }, [inst2.installationId]: inst2.signingSecret }),
      OVMEM_MULTICA_API_URL: `${cfg.mcBase}/v1`,
      OVMEM_PLUGIN_TOKEN: ADMIN_TOKEN,
      OVMEM_TLS_CERT: cfg.tlsCert, OVMEM_TLS_KEY: cfg.tlsKey,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  plugin.stdout.on('data', (d) => pluginLog.push(d.toString()));
  plugin.stderr.on('data', (d) => pluginLog.push(d.toString()));
  const daemons = [];
  const cleanup = async () => {
    for (const d of daemons) d.stop();
    await mockMode('write');
    plugin.kill('SIGTERM');
  };

  try {
    await waitFor('plugin healthz', async () => (await pluginCall('/healthz')).json?.result?.ov?.healthy, { timeoutMs: 30_000 });

    const statusLog = () => (existsSync(join(stateDir, 'archives.jsonl'))
      ? readFileSync(join(stateDir, 'archives.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : []);
    const entry = (pred) => statusLog().find(pred);
    const scopes = () => JSON.parse(readFileSync(join(stateDir, 'scopes.json'), 'utf8')).scopes;
    const ovSearch = async (scopeKey, query) => {
      const rec = scopes()[scopeKey];
      if (!rec) return [];
      const r = await jfetch(`${cfg.ovBase}/api/v1/search/search`, { method: 'POST', headers: { Authorization: `Bearer ${rec.apiKey}` }, body: { query, mode: 'list', limit: 10 } });
      return (r.json?.result?.memories ?? []).filter((m) => m.context_type === 'memory' && !/\.(overview|abstract)\.md$/.test(m.uri));
    };
    const hitContent = async (scopeKey, hits) => {
      const rec = scopes()[scopeKey];
      const files = await Promise.all(hits.map(async (hit) => {
        const r = await jfetch(`${cfg.ovBase}/api/v1/content/read?offset=0&limit=400&uri=${encodeURIComponent(hit.uri)}`,
          { headers: { Authorization: `Bearer ${rec.apiKey}` } });
        return typeof r.json?.result === 'string' ? r.json.result : r.json?.result?.content ?? '';
      }));
      return files.join('\n');
    };
    const realModel = !cfg.mockLlm;
    const extracted = (ref) => waitFor(`extraction of ${ref}`, async () => entry((e) => e.type === 'extraction' && e.ref === ref && e.extraction === 'done'), { timeoutMs: 180_000 });

    // ---------------------------------------------------------------- workspace 1
    const d1 = await mc.daemon(u1.token, ws1);
    daemons.push(d1);
    const agentA = await d1.createAgent(`agent-a-${RUN}`);
    const agentB = await d1.createAgent(`agent-b-${RUN}`);
    const issueX = await mc.createIssue(u1.token, ws1, { title: '消息推送服务选型与灰度迁移方案', description: '对比 Kafka 与 RocketMQ,评估顺序性、死信队列、事务消息。预算上限 ¥5000/月。' });
    const notes = await mc.createIssue(u1.token, ws1, { title: '运维约定汇总', description: '不指派智能体;只用于评论。' });
    const taskScopeX = `task:${ws1}:${issueX.id}`;
    const taskScopeNotes = `task:${ws1}:${notes.id}`;

    // R1 — a member's comment is archived as attributed human feedback and distilled
    const c1 = await mc.comment(u1.token, ws1, issueX.id, '死信队列的监控告警要求补充进方案,峰值堆积阈值 1 万条。');
    const acc1 = await waitFor('comment accepted', async () => entry((e) => e.ref === c1.id && e.type === 'accepted'));
    await extracted(c1.id);
    const r1hits = await waitFor('comment memory preserves the alarm threshold', async () => {
      const h = await ovSearch(taskScopeX, '死信队列 告警 阈值');
      const text = h.length ? await hitContent(taskScopeX, h) : '';
      return h.length && (!realModel || /1\s*万|一万|10[,.]?000/.test(text)) ? h : null;
    });
    step('R1', 'member comment → comment.created → archived as human feedback → extracted → searchable', acc1.author === 'member' && r1hits.length > 0,
      `author=${acc1.author} scope=task memories=${r1hits.length} ${realModel ? 'threshold 10000 preserved' : 'mock plumbing'}`);

    // R2 — an issue run: agent tools in the run, then task.completed
    await mc.assign(u1.token, ws1, issueX.id, agentA.id);
    const runA = await d1.claimAndStart(agentA.id, (t) => t.issue_id === issueX.id);
    await d1.report(runA.id, [
      { seq: 1, type: 'text', content: '我将从顺序性、事务消息、死信队列和生态四个维度对比两个候选。' },
      { seq: 2, type: 'tool_use', tool: 'web_search', input: { query: 'rocketmq transactional message ordering' } },
      { seq: 3, type: 'tool_result', tool: 'web_search', output: 'RocketMQ 提供队列级顺序 + 事务消息;Kafka 仅有分区内顺序。' },
      { seq: 4, type: 'text', content: '最终结论:推荐 RocketMQ。理由:队列级顺序、事务消息原生支持,灰度方案先双写两周,预算 ¥3800/月在限额内。' },
    ]);
    const recallA = await d1.hook(runA.id, inst1.installationId, 'memory-recall',
      { query: '死信队列 告警 阈值', ...(flavor === 'stock' ? { issue_id: issueX.identifier } : {}) });
    const recallOk = recallA.status === 'ok' && recallA.result.entries.some((e) => e.scope === taskScopeX)
      && (!realModel || recallA.result.entries.some((e) => /1\s*万|一万|10[,.]?000/.test(e.content ?? '')))
      && recallA.result.run.bound === (flavor === 'patched') && (flavor === 'stock' || recallA.result.run.kind === 'issue');
    step('R2a', `in-run memory-recall finds the issue's collaboration memory (${flavor === 'patched' ? 'bound to the calling run' : 'issue named by the agent'})`, recallOk,
      `bound=${recallA.result?.run?.bound} kind=${recallA.result?.run?.kind} entries=${recallA.result?.entries?.length} ${recallA.error ? JSON.stringify(recallA.error) : ''}`);
    const rem = { title: '选型对比模板', content: '中间件选型按 顺序性/事务/死信/生态/成本 五维对比,并给出灰度与回滚方案。', kind: 'experiences' };
    const rem1 = await d1.hook(runA.id, inst1.installationId, 'memory-remember', rem);
    const rem2 = await d1.hook(runA.id, inst1.installationId, 'memory-remember', rem);
    step('R2b', 'memory-remember writes the agent\'s public memory, and a repeat is idempotent',
      rem1.result?.status === 'remembered' && rem2.status === 'ok' && rem2.result?.status === 'already_remembered',
      `first=${rem1.result?.status} second=${rem2.result?.status ?? JSON.stringify(rem2.error)}`);
    const remembered = await waitFor('active memory recalled with its original content', async () => {
      const recalled = await d1.hook(runA.id, inst1.installationId, 'memory-recall', { query: '中间件选型 五维对比 模板 灰度 回滚方案' });
      return recalled.result?.entries?.find((e) => e.uri === rem1.result?.uri && e.content?.includes(rem.content));
    });
    step('R2b-recall', 'memory-remember → background index → in-run memory-recall returns the exact file and original five-dimension template',
      Boolean(remembered), `scope=${remembered.scope.split(':')[0]} original content preserved`);
    await d1.complete(runA.id, '最终结论:推荐 RocketMQ。');
    if (flavor === 'patched') {
      const accRun = await waitFor('run accepted', async () => entry((e) => e.ref === runA.id && (e.type === 'accepted' || e.type === 'skipped')));
      if (accRun.type === 'accepted') await extracted(runA.id);
      const runHits = accRun.type === 'accepted' ? await waitFor('run memory preserves the decision, budget and rollout', async () => {
        const h = await ovSearch(taskScopeX, 'RocketMQ 预算 灰度 双写');
        const text = h.length ? await hitContent(taskScopeX, h) : '';
        return h.length && (!realModel || (/RocketMQ/.test(text) && /3[,.]?800/.test(text) && /两周|2\s*周|二周/.test(text))) ? h : null;
      }).catch(() => []) : [];
      step('R2c', 'task.completed → run transcript read from the task API → archived complete → extracted → searchable',
        accRun.type === 'accepted' && accRun.kind === 'issue' && accRun.completeness === 'complete' && runHits.length > 0,
        `${accRun.type} kind=${accRun.kind} completeness=${accRun.completeness ?? accRun.reason} memories=${runHits.length} ${realModel ? 'RocketMQ/3800/two-week dual-write preserved' : 'mock plumbing'}`);
    } else {
      const skipped = await waitFor('run event handled', async () => entry((e) => e.ref === runA.id));
      step('R2c', 'stock multica: task.completed without a task API is skipped with 200 (no noise archive, no breaker strike)',
        skipped.type === 'skipped', skipped.reason ?? skipped.type);
    }

    // R2d — the run's closing comment (posted by multica from the run output)
    const closing = await waitFor('run closing comment', async () => {
      const r = await mc.call(`/api/issues/${issueX.id}/comments`, { token: u1.token, ws: ws1 });
      const list = Array.isArray(r.json) ? r.json : (r.json?.comments ?? []);
      return list.find((c) => c.author_type === 'agent') ?? null;
    }, { timeoutMs: 30_000 });
    const closingSeen = await waitFor('closing comment handled', async () => entry((e) => e.ref === closing.id && (e.type === 'accepted' || e.type === 'skipped')), { timeoutMs: 30_000 });
    if (flavor === 'patched') {
      step('R2d', 'the run\'s closing agent comment is not archived a second time (the run archive covers it)',
        closingSeen.type === 'skipped' && /covered by its run archive/.test(closingSeen.reason ?? ''), closingSeen.reason ?? closingSeen.type);
    } else {
      step('R2d', 'stock multica: the run is represented by its closing comment, archived as the agent\'s statement',
        closingSeen.type === 'accepted' && closingSeen.author === 'agent', `${closingSeen.type} author=${closingSeen.author}`);
    }

    // R3 — direct-chat runs (issue_id "") never trip multica's breaker; with the
    //      task API they land in the private agent×member scope
    const chat = await mc.must('create chat', mc.call('/api/chat/sessions', { method: 'POST', token: u1.token, ws: ws1, body: { agent_id: agentA.id, title: 'e2e chat' } }));
    const chatTasks = [];
    for (let i = 1; i <= 6; i++) {
      const text = i === 1 ? '记住:这个项目所有代码注释一律用中文。' : `第 ${i} 轮:接口命名保持驼峰,记住这个约定。`;
      await mc.must('send chat', mc.call(`/api/chat/sessions/${chat.id}/messages`, { method: 'POST', token: u1.token, ws: ws1, body: { content: text } }));
      const t = await d1.claimAndStart(agentA.id, (task) => task.chat_session_id === chat.id);
      await d1.report(t.id, [{ seq: 1, type: 'text', content: `好的,已记住(第 ${i} 轮)。` }]);
      await d1.complete(t.id, `好的,已记住(第 ${i} 轮)。`);
      chatTasks.push(t.id);
    }
    const chatOutcomes = await waitFor('all chat runs handled', async () => {
      const got = chatTasks.map((id) => entry((e) => e.ref === id && (e.type === 'accepted' || e.type === 'skipped')));
      return got.every(Boolean) ? got : null;
    }, { timeoutMs: 60_000 });
    const probe = await mc.comment(u1.token, ws1, notes.id, '补充:回滚演练必须在灰度第一周完成。BREAKER-PROBE');
    const probeSeen = await waitFor('post-chat comment archived', async () => entry((e) => e.ref === probe.id && e.type === 'accepted'), { timeoutMs: 30_000 }).catch(() => null);
    step('R3a', '6 chat runs later, memory-archive still receives events (breaker closed)', Boolean(probeSeen),
      `chat outcomes: ${[...new Set(chatOutcomes.map((e) => e.type))].join(',')}`);
    const dmScope = `dm:${ws1}:${agentA.id}:${u1.userId}`;
    if (flavor === 'patched') {
      // What the plugin controls: the member's own words (read through chats:read)
      // archived in the pair scope, attributed to that member, then extracted.
      await Promise.all(chatTasks.map(extracted));
      const archived = entry((e) => e.type === 'archive-run' && e.ref === chatTasks[0]);
      const dmRec = scopes()[dmScope];
      const read = await jfetch(`${cfg.ovBase}/api/v1/content/read?offset=0&limit=200&uri=${encodeURIComponent(`viking://user/${dmRec.userId}/sessions/${archived.session_id}/history/archive_001/messages.jsonl`)}`,
        { headers: { Authorization: `Bearer ${dmRec.apiKey}` } });
      const messages = String(read.json?.result ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const memberWords = messages.find((m) => m.role === 'user' && JSON.stringify(m.parts ?? m.content).includes('代码注释一律用中文'));
      const taskText = await hitContent(taskScopeX, await ovSearch(taskScopeX, '代码注释 中文 接口命名 驼峰'));
      const leakedToTask = /代码注释|驼峰/.test(taskText);
      const dmHits = await waitFor('DM preferences remain retrievable', async () => {
        const h = await ovSearch(dmScope, '代码注释 中文 接口命名 驼峰 约定');
        const text = h.length ? await hitContent(dmScope, h) : '';
        return h.length && (!realModel || (/中文/.test(text) && /驼峰|camelCase/.test(text))) ? h : null;
      });
      step('R3b', 'chat runs preserve attributed member input and retrievable preferences in the private agent×member scope',
        chatOutcomes.every((e) => e.type === 'accepted' && e.scope === dmScope) && memberWords?.peer_id === u1.userId && !leakedToTask,
        `scopes=${[...new Set(chatOutcomes.map((e) => e.scope?.split(':')[0]))].join(',')} member peer_id=${memberWords?.peer_id === u1.userId} dm memories=${dmHits.length}`);
    } else {
      step('R3b', 'stock multica: chat runs are skipped with 200, not archived into an issue scope',
        chatOutcomes.every((e) => e.type === 'skipped'), chatOutcomes[0]?.reason);
    }

    // R4 — ov-* facade: confined to the calling agent's own space
    const issueZ = await mc.createIssue(u1.token, ws1, { title: `A 的第二个任务 ${RUN}`, description: 'facade' });
    await mc.assign(u1.token, ws1, issueZ.id, agentA.id);
    const runA2 = await d1.claimAndStart(agentA.id, (t) => t.issue_id === issueZ.id);
    const issueY = await mc.createIssue(u1.token, ws1, { title: `B 的无关任务 ${RUN}`, description: 'recall binding' });
    await mc.assign(u1.token, ws1, issueY.id, agentB.id);
    const runB = await d1.claimAndStart(agentB.id, (t) => t.issue_id === issueY.id);
    const toShared = await d1.hook(runA2.id, inst1.installationId, 'ov-write', { uri: 'viking://resources/e2e/leak.md', content: 'A-PRIVATE: 报价底线 ¥3800/月', mode: 'create' });
    const own = await d1.hook(runA2.id, inst1.installationId, 'ov-write', { uri: 'viking://~/notes/e2e.md', content: 'A-PRIVATE-NOTE 报价底线 ¥3800/月', mode: 'create', wait: true });
    const aUser = scopes()[`agent:${ws1}:${agentA.id}`]?.userId;
    const bReads = await d1.hook(runB.id, inst1.installationId, 'ov-read', { uris: `viking://user/${aUser}/notes/e2e.md` });
    const bLists = await d1.hook(runB.id, inst1.installationId, 'ov-list', {});
    step('R4', 'ov-* facade: shared namespaces and other agents\' spaces are refused, the own space works',
      toShared.error?.code === 'outside_own_space' && own.status === 'ok' && bReads.error?.code === 'outside_own_space'
        && bLists.status === 'ok' && !String(bLists.result?.output ?? '').includes('A-PRIVATE-NOTE'),
      `A→resources=${toShared.error?.code} A→own=${own.status} B→A's space=${bReads.error?.code} B list=${bLists.status}`);

    // R5 — recall binding: agent B, running on issue Y, asks for issue X
    const recallB = await d1.hook(runB.id, inst1.installationId, 'memory-recall', { query: '死信队列 告警 阈值', issue_id: issueX.identifier });
    const searchedX = recallB.result?.scopesSearched?.some((s) => s.scope === taskScopeX);
    if (flavor === 'patched') {
      step('R5', 'memory-recall is bound to the calling run: another issue named by the model is not searched',
        recallB.status === 'ok' && recallB.result.run.bound === true && !searchedX,
        `bound=${recallB.result?.run?.bound} searched X=${searchedX} notes=${JSON.stringify(recallB.result?.notes ?? [])}`);
    } else {
      step('R5', 'stock multica: recall cannot know the calling run and is reported unbound (documented limitation)',
        recallB.status === 'ok' && recallB.result.run.bound === false, `bound=${recallB.result?.run?.bound} searched X=${searchedX}`);
    }
    await d1.complete(runA2.id, 'done');
    await d1.complete(runB.id, 'done');

    // R6 — tenant isolation across installations
    const d2 = await mc.daemon(u2.token, ws2);
    daemons.push(d2);
    const agent2 = await d2.createAgent(`ws2-agent-${RUN}`);
    const issue2 = await mc.createIssue(u2.token, ws2, { title: 'ws2 task', description: 'tenant 2' });
    await mc.assign(u2.token, ws2, issue2.id, agent2.id);
    const run2 = await d2.claimAndStart(agent2.id, (t) => t.issue_id === issue2.id);
    const status2 = await d2.hook(run2.id, inst2.installationId, 'memory-status', {});
    await d2.complete(run2.id, 'done');
    const status2Text = JSON.stringify(status2.result ?? status2.error ?? null);
    const forgedBody = {
      version: 1, invocation_id: randomUUID(), attempt: 1, occurred_at: new Date().toISOString(),
      hook_key: 'memory-recall', trigger: 'agent', workspace_id: ws1, installation_id: inst2.installationId,
      actor: { type: 'agent', id: agentA.id }, input: { query: '死信队列 告警 阈值', issue_id: issueX.id }, config: {},
      callback_token: 'mpc_forged', callback_url: `${cfg.mcBase}/v1`,
    };
    const forged = await signedHook('memory-recall', forgedBody, { secret: inst2.signingSecret, installation: inst2.installationId });
    const impersonated = await signedHook('memory-recall', { ...forgedBody, installation_id: inst1.installationId }, { secret: inst2.signingSecret, installation: inst1.installationId });
    const admin = await pluginCall('/admin/status', { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    const binding2 = admin.json?.result?.installations?.find((b) => b.installation_id === inst2.installationId);
    step('R6', 'tenant isolation: workspace 2 sees none of workspace 1, and its secret cannot reach workspace 1',
      status2.status === 'ok' && !status2Text.includes(ws1) && forged.status === 403 && impersonated.status === 401
        && binding2?.workspace_id === ws2 && binding2?.via === 'context',
      `ws2 status mentions ws1=${status2Text.includes(ws1)} forged=${forged.status} impersonated=${impersonated.status} inst2 bound via=${binding2?.via}`);

    // R7 — a failed extraction is re-driven in a fresh session and recovers
    if (cfg.mockLlm) {
      await waitFor('earlier extractions settled', async () => {
        const r = await pluginCall('/admin/status', { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
        return r.json?.result?.extraction?.pending === 0;
      }, { timeoutMs: 240_000, intervalMs: 2_000 });
      await mockMode('fail');
      const c7 = await mc.comment(u1.token, ws1, notes.id, '约定:发布窗口只在周二和周四。REDRIVE-PROBE');
      const redriven = await waitFor('extraction re-driven', async () => entry((e) => e.type === 'extraction' && e.ref === c7.id && e.extraction === 'redriven'), { timeoutMs: 240_000 });
      await mockMode('write');
      const done = await waitFor('re-driven extraction done', async () => entry((e) => e.type === 'extraction' && e.ref === c7.id && e.extraction === 'done'), { timeoutMs: 240_000 });
      const rec = scopes()[taskScopeNotes];
      const r1Session = await jfetch(`${cfg.ovBase}/api/v1/sessions/mc-comment-${c7.id}-r1`, { headers: { Authorization: `Bearer ${rec.apiKey}` } });
      step('R7', 'LLM failure → extraction failed → re-driven in a fresh session (-r1) → extracted',
        Boolean(redriven) && done.generation === 1 && r1Session.status === 200,
        `failed error=${String(redriven.error ?? '').slice(0, 60)} done generation=${done.generation} r1 session=${r1Session.status}`);
    }
  } catch (err) {
    step('ERR', 'unexpected failure', false, err.message);
    console.error(pluginLog.join('').slice(-3000));
  } finally {
    await cleanup();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nREAL-STACK RESULT (${flavor} multica): ${results.length - failed.length}/${results.length} steps passed`);
  if (cfg.report) {
    mkdirSync(dirname(cfg.report), { recursive: true });
    writeFileSync(cfg.report, JSON.stringify({ flavor, model_mode: cfg.mockLlm ? 'mock' : 'real', run: RUN, finished_at: new Date().toISOString(), results }, null, 2) + '\n');
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
