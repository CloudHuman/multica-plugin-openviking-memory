#!/usr/bin/env node
/**
 * Long-run extraction quality with real models: one 2,408-message run with
 * eight planted facts, archived and extracted in different ways, then checked
 * in the extracted memory files and through recall.
 *
 *   hook                read inside the hook (first 2,000 messages), one extraction
 *                       — the plugin without an install token
 *   background          read whole in the background with the install token; one
 *                       extraction, since the record is below extractBatchTokens
 *   background-batched  read whole, extractBatchTokens lowered to 60,000 so the
 *                       record is extracted in five batches, each opening with
 *                       the run's context (the path for records too large for
 *                       one extraction)
 *
 * Each variant gets its own workspace (its own OpenViking account), its own
 * plugin process and a fresh state directory, and runs after the previous one
 * has finished. The facts sit at different depths of the run; three of them come
 * after message 2,000.
 *
 * This calls real models through OpenViking and costs money: run it only when
 * that is authorized. Same prerequisites as run.mjs (patched multica, OpenViking
 * with deploy/ov.openrouter.conf.example, dev CA and plugin certificate).
 *
 * Env: OV_ROOT_KEY, OVMEM_TLS_CERT, OVMEM_TLS_KEY, PLUGIN_CA (required);
 *      MC_BASE, MC_DEV_CODE, OV_BASE, PLUGIN_URL (as in run.mjs);
 *      LONG_RUN_VARIANTS=hook,background,background-batched  LONG_RUN_REPEAT=1
 *      REPORT_FILE=…  write the results as JSON
 *      OPENROUTER_API_KEY  optional: read the key's credit usage before and after
 *                          (only the usage figure is kept)
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Multica, sleep } from './multica.mjs';
import { OvClient } from '../../src/ov-client.mjs';

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
  variants: (env.LONG_RUN_VARIANTS ?? 'hook,background,background-batched').split(',').map((s) => s.trim()).filter(Boolean),
  repeat: Math.max(1, Number(env.LONG_RUN_REPEAT ?? 1) || 1),
  report: env.REPORT_FILE ?? '',
};
const VARIANTS = {
  hook: { token: false, config: {} },
  background: { token: true, config: {} },
  'background-batched': { token: true, config: { extractBatchTokens: 60_000 } },
};

const pluginPort = Number(new URL(cfg.pluginUrl).port || 443);
const RUN = Date.now().toString(36);
const ov = new OvClient({ baseUrl: cfg.ovBase, timeoutMs: 60_000 });

// ------------------------------------------------------------------ the run

const STEPS = 800;
const REGIONS = ['cn-east-1', 'cn-east-2', 'cn-north-1', 'cn-south-1'];

/**
 * Planted facts: where they sit, what the run says, a recall question that does
 * not contain the answer, and what a memory must state to count. A fact counts
 * when one memory file (or one recalled entry) satisfies every pattern.
 */
export const FACTS = [
  { id: 'F1', step: 10, depth: 'early',
    text: '和负责人确认了本次巡检的基准：orders 服务的重试上限统一为 5 次（原为 3 次），依据是 INC-2291 的故障复盘。',
    query: 'orders 服务的重试上限是多少？', must: [/重试/, /5\s*次|五次/, /INC-2291|3\s*次|三次/] },
  { id: 'F2', step: 133, depth: 'early',
    text: '和 payment 组对齐后定下：payment-callback 的回调超时阈值定为 8 秒，超过 8 秒按失败处理并进入重试。',
    query: 'payment-callback 回调的超时阈值是多少？', must: [/payment[-_ ]?callback|支付回调/i, /8\s*秒|8\s*s\b|八秒/i] },
  { id: 'F3', step: 300, depth: 'middle',
    text: '死信队列的保留期从 3 天延长到 7 天，新增的存储预算约 ¥1200/月，已经获批。',
    query: '死信队列保留多久？存储预算多少？', must: [/死信/, /7\s*天|七天/, /1[,，]?200/] },
  { id: 'F4', step: 433, depth: 'middle', shard: 'orders-433', drift: { max_retries: 9 },
    text: '发现配置漂移：orders-433 的重试上限是 9 次，偏离了 5 次的基准，重试风暴风险偏高。',
    query: 'orders-433 分片有什么问题？', must: [/orders-433/, /9\s*次|max_retries\D{0,4}9\b|重试[^。\n]{0,8}9/] },
  { id: 'F5', step: 566, depth: 'late', shard: 'orders-566', drift: { dlq_retention_days: 1 },
    text: '发现配置漂移：orders-566 的死信保留只有 1 天，低于 7 天的基准。',
    query: 'orders-566 分片有什么问题？', must: [/orders-566/, /(?<!\d)1\s*天|一天|dlq_retention_days\D{0,4}1\b/] },
  { id: 'F6', step: 700, depth: 'tail', shard: 'orders-700', drift: { callback_timeout_s: 30 },
    text: '发现配置漂移：orders-700 的回调超时是 30 秒，远高于 8 秒的阈值。',
    query: 'orders-700 分片有什么问题？', must: [/orders-700/, /30\s*秒|30\s*s\b|callback_timeout_s\D{0,4}30\b/i] },
  { id: 'F7', step: 750, depth: 'tail',
    text: '修正计划：漂移分片在周二 14:00 的灰度窗口统一修正，回滚负责人是王磊。',
    query: '漂移分片什么时候修正？谁负责回滚？', must: [/王磊/, /周二|星期二|14[:：]00/] },
  { id: 'F8', step: STEPS, depth: 'tail',
    text: '巡检结论：800 个分片中有 3 个配置漂移（orders-433、orders-566、orders-700），其余 797 个符合基准；修正后需要复查告警。',
    query: '这次分片巡检的结论是什么？有几个分片配置漂移？', must: [/797\s*个|(?:3|三)\s*个[^。\n]{0,12}漂移|漂移[^。\n]{0,12}(?:3|三)\s*个/] },
];

function healthOutput(i) {
  const lines = [
    `orders-${i} healthz: ok`,
    `region=${REGIONS[i % 4]} zone=${String.fromCharCode(97 + (i % 3))} version=v4.${i % 13}.${i % 7}`,
    `cpu=${17 + ((i * 7) % 50)}% mem=${900 + ((i * 37) % 600)}MiB restarts_24h=${i % 3}`,
    `p50_ms=${11 + (i % 9)} p99_ms=${80 + ((i * 13) % 120)} error_rate=0.0${i % 5}%`,
    'recent log:',
  ];
  const logLines = i % 10 === 0 ? 40 : 6;
  for (let k = 0; k < logLines; k++) {
    lines.push(`  [INFO] consumer group orders-g${(i + k) % 16} lag=${(i * 31 + k * 17) % 900} checkpoint offset=${i * 1000 + k * 97}`);
  }
  return lines.join('\n');
}

export function longTranscript() {
  const t = [];
  const add = (m) => t.push({ seq: t.length + 1, ...m });
  const factAt = new Map(FACTS.map((f) => [f.step, f]));
  for (let i = 0; i < STEPS; i++) {
    const fact = factAt.get(i);
    add({ type: 'text', content: `第 ${i} 步：检查分片 orders-${i} 的健康状态和资源水位。` });
    add({ type: 'tool_use', tool: 'bash', call_id: `c${i}`, input: { command: `curl -s http://orders-${i}:9090/healthz?verbose=1` } });
    let output = healthOutput(i);
    if (fact?.drift) output += `\nconfig:\n${Object.entries(fact.drift).map(([k, v]) => `  ${k}: ${v}`).join('\n')}`;
    add({ type: 'tool_result', tool: 'bash', call_id: `c${i}`, output });
    if (fact) add({ type: 'text', content: fact.text });
  }
  add({ type: 'text', content: FACTS.find((f) => f.step === STEPS).text });
  return t;
}

// ------------------------------------------------------------------ plumbing

function pluginCall(path, { method = 'GET', headers = {}, body } = {}) {
  const url = new URL(path, cfg.pluginUrl);
  const raw = body === undefined ? undefined : JSON.stringify(body);
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

async function waitFor(label, fn, { timeoutMs = 120_000, intervalMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** The key's cumulative credit usage (USD); the key itself is only sent to OpenRouter. */
async function openRouterUsage() {
  if (!env.OPENROUTER_API_KEY) return null;
  try {
    const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` } });
    const j = await r.json();
    return typeof j?.data?.usage === 'number' ? j.data.usage : null;
  } catch {
    return null;
  }
}

function buildPackage() {
  const out = execFileSync('bash', [join(root, 'scripts', 'package.sh'), '--url', cfg.pluginUrl, '--with-chats-read'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const m = out.match(/packaged: (\S+\.zip)/);
  if (!m) throw new Error(`package.sh printed no package path:\n${out}`);
  return join(root, m[1]);
}

/** Every memory file the scope's key can see: its user space and any agent space. */
async function memoryFiles(rec) {
  const files = [];
  const walk = async (uri, depth = 0) => {
    if (depth > 8) return;
    let entries;
    try { entries = await ov.listDir(rec.apiKey, uri); } catch { return; }
    for (const e of entries) {
      const child = e.uri ?? `${uri.replace(/\/$/, '')}/${e.name}`;
      if (e.isDir || e.is_dir || e.type === 'directory') await walk(child, depth + 1);
      // identity.md and soul.md are OpenViking's per-user templates, not extracted memories.
      else if (child.endsWith('.md') && /\/memories\//.test(child) && !/\/\.(?:overview|abstract)\.md$|\/memories\/(?:identity|soul)\.md$/.test(child)) files.push(child);
    }
  };
  await walk(`viking://user/${rec.userId}/memories`);
  let agents = [];
  try { agents = await ov.listDir(rec.apiKey, 'viking://agent'); } catch { /* no agent space */ }
  for (const a of agents) await walk(`${(a.uri ?? `viking://agent/${a.name}`).replace(/\/$/, '')}/memories`);
  const out = [];
  for (const uri of files) {
    const r = await ov.readContent(rec.apiKey, uri, { limit: 2000 }).catch(() => ({ content: '' }));
    out.push({ uri, content: String(r.content ?? '').replace(/<!--[\s\S]*?-->/g, '') });
  }
  return out;
}

const satisfies = (fact, text) => fact.must.every((re) => re.test(text));

// ------------------------------------------------------------------ one variant

async function runVariant(mc, zip, name, round) {
  const v = VARIANTS[name];
  const label = `${name}#${round}`;
  const u = await mc.login(`ovmem-long-${RUN}-${name}-${round}@example.com`);
  const ws = await mc.createWorkspace(u.token, { name: `OV long run ${RUN} ${label}`, slug: `ovlong-${RUN}-${name}-${round}`.replace(/[^a-z0-9-]/g, ''), prefix: 'OVL' });
  const pub = await mc.publishPlugin(u.token, ws, zip);
  if (pub.status >= 300) throw new Error(`publish: ${pub.status} ${pub.text.slice(0, 300)}`);
  const inst = await mc.installPlugin(u.token, ws, pub.json.versions?.[0]?.id ?? pub.json.version?.id ?? pub.json.version_id);

  const stateDir = mkdtempSync(join(tmpdir(), `ovmem-long-${name}-`));
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    extractPollIntervalMs: 5_000, extractPollMaxIntervalMs: 15_000,
    ...v.config,
  }));
  const admin = `long-admin-${randomUUID()}`;
  const pluginLog = [];
  const plugin = spawn(process.execPath, [join(root, 'src', 'server.mjs')], {
    env: {
      PATH: env.PATH, HOME: env.HOME,
      OVMEM_PORT: String(pluginPort), OVMEM_BIND: '127.0.0.1', OVMEM_STATE_DIR: stateDir,
      OVMEM_OV_BASE_URL: cfg.ovBase, OVMEM_OV_ROOT_KEY: cfg.ovRootKey,
      OVMEM_SIGNING_SECRETS: JSON.stringify({ [inst.installationId]: { secret: inst.signingSecret, workspace_id: ws, ...(v.token ? { token: inst.installationToken } : {}) } }),
      OVMEM_MULTICA_API_URL: `${cfg.mcBase}/v1`,
      OVMEM_PLUGIN_TOKEN: admin,
      OVMEM_TLS_CERT: cfg.tlsCert, OVMEM_TLS_KEY: cfg.tlsKey,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  plugin.stdout.on('data', (d) => pluginLog.push(d.toString()));
  plugin.stderr.on('data', (d) => pluginLog.push(d.toString()));
  let daemon;
  try {
    await waitFor('plugin healthz', async () => (await pluginCall('/healthz')).json?.result?.ov?.healthy, { timeoutMs: 30_000 });
    const statusLog = () => (existsSync(join(stateDir, 'archives.jsonl'))
      ? readFileSync(join(stateDir, 'archives.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    const entry = (pred) => statusLog().find(pred);

    daemon = await mc.daemon(u.token, ws);
    const agent = await daemon.createAgent(`inspector-${RUN}-${name}-${round}`);
    const issue = await mc.createIssue(u.token, ws, { title: 'orders 服务分片巡检', description: '逐个检查 orders 服务全部 800 个分片的健康状态和配置，找出偏离基准的分片并给出修正计划。' });
    await mc.assign(u.token, ws, issue.id, agent.id);
    const run = await daemon.claimAndStart(agent.id, (t) => t.issue_id === issue.id);
    const transcript = longTranscript();
    for (let i = 0; i < transcript.length; i += 200) await daemon.report(run.id, transcript.slice(i, i + 200));
    const usageBefore = await openRouterUsage();
    const started = Date.now();
    await daemon.complete(run.id, transcript.at(-1).content);

    const accepted = await waitFor('run archived', async () => entry((e) => e.ref === run.id && e.type === 'accepted' && e.kind), { timeoutMs: 300_000 });
    const pending = await waitFor('run committed', async () => entry((e) => e.ref === run.id && e.extraction === 'pending'), { timeoutMs: 300_000 });
    const settled = await waitFor('extraction settled', async () => entry((e) => e.type === 'extraction' && e.ref === run.id && ['done', 'failed', 'timeout'].includes(e.extraction)),
      { timeoutMs: 90 * 60_000, intervalMs: 10_000 });
    const extractionSeconds = Math.round((Date.now() - started) / 1000);
    console.log(`[${label}] extraction ${settled.extraction} after ${extractionSeconds}s (archived ${pending.messages} messages, ${accepted.completeness})`);

    const scopes = JSON.parse(readFileSync(join(stateDir, 'scopes.json'), 'utf8')).scopes;
    const taskScope = `task:${ws}:${issue.id}`;
    const rec = scopes[taskScope];
    // Memories are embedded after the extraction task completes: wait until the
    // set of searchable memories stops growing before asking recall questions.
    let last = -1;
    for (let i = 0; i < 18; i++) {
      await sleep(10_000);
      const n = (await ov.search(rec.apiKey, { query: 'orders 分片 巡检', limit: 50 }).catch(() => null))?.memories?.length ?? 0;
      if (n === last && n > 0) break;
      last = n;
    }
    const files = await memoryFiles(rec);
    const recall = [];
    for (const fact of FACTS) {
      const r = await pluginCall('/admin/test-recall', { method: 'POST', headers: { Authorization: `Bearer ${admin}` }, body: { scopes: [taskScope], query: fact.query, entries: 5 } });
      const entries = r.json?.result?.entries ?? [];
      const hit = entries.findIndex((e) => satisfies(fact, `${e.abstract ?? ''}\n${e.content ?? ''}`));
      recall.push({ id: fact.id, rank: hit < 0 ? null : hit + 1, entries: entries.length });
    }
    await sleep(60_000); // credit usage is reported with a short delay
    const usageAfter = await openRouterUsage();
    const result = {
      variant: name, round, workspace: ws, run: run.id,
      transcript: transcript.length, archived: pending.messages, completeness: accepted.completeness,
      batches: pending.extraction_batches ?? 'one', extraction: settled.extraction, extraction_error: settled.error ?? null, extractionSeconds,
      memoryFiles: files.length,
      memoryKinds: files.reduce((m, f) => { const k = f.uri.match(/\/memories\/([^/]+)/)?.[1] ?? '?'; m[k] = (m[k] ?? 0) + 1; return m; }, {}),
      facts: FACTS.map((f) => ({
        id: f.id, depth: f.depth, afterMessage2000: transcript.findIndex((m) => m.content === f.text) >= 2000,
        inMemory: files.filter((file) => satisfies(f, file.content)).map((file) => file.uri.replace(/^viking:\/\/[^/]+\/[^/]+\//, '')),
        recallRank: recall.find((r) => r.id === f.id).rank,
      })),
      usd: usageBefore != null && usageAfter != null ? Math.round((usageAfter - usageBefore) * 10_000) / 10_000 : null,
      memories: files.map((f) => ({ uri: f.uri.replace(/^viking:\/\/[^/]+\/[^/]+\//, ''), content: f.content.slice(0, 1500) })),
    };
    const found = result.facts.filter((f) => f.inMemory.length).length;
    const recalled = result.facts.filter((f) => f.recallRank).length;
    console.log(`[${label}] facts in memory ${found}/${FACTS.length}, recalled in top 5 ${recalled}/${FACTS.length}, memory files ${files.length}, usd ${result.usd ?? 'n/a'}`);
    return result;
  } catch (err) {
    console.error(`[${label}] ${err.message}`);
    console.error(pluginLog.join('').slice(-3000));
    return { variant: name, round, error: err.message };
  } finally {
    daemon?.stop();
    plugin.kill('SIGTERM');
    await new Promise((r) => plugin.once('exit', r));
  }
}

async function main() {
  for (const [k, v] of Object.entries({ OV_ROOT_KEY: cfg.ovRootKey, OVMEM_TLS_CERT: cfg.tlsCert, OVMEM_TLS_KEY: cfg.tlsKey, PLUGIN_CA: cfg.pluginCa })) {
    if (!v) {
      console.error(`${k} is required (see e2e/real-stack/README.md)`);
      process.exit(2);
    }
  }
  for (const v of cfg.variants) if (!VARIANTS[v]) { console.error(`unknown variant ${v}`); process.exit(2); }
  const mc = new Multica({ base: cfg.mcBase, devCode: cfg.devCode });
  const zip = buildPackage();
  const t = longTranscript();
  console.log(`transcript: ${t.length} messages, ${t.reduce((n, m) => n + JSON.stringify(m).length, 0)} chars; facts after message 2000: ${FACTS.filter((f) => t.findIndex((m) => m.content === f.text) >= 2000).map((f) => f.id).join(', ')}`);
  const results = [];
  for (let round = 1; round <= cfg.repeat; round++) {
    for (const name of cfg.variants) results.push(await runVariant(mc, zip, name, round));
  }
  console.log('\nvariant              facts in memory   recalled (top 5)   files   batches   usd');
  for (const r of results) {
    if (r.error) { console.log(`${`${r.variant}#${r.round}`.padEnd(20)} ERROR ${r.error}`); continue; }
    const mem = r.facts.map((f) => (f.inMemory.length ? f.id : '--')).join(' ');
    const rec = r.facts.map((f) => (f.recallRank ? f.id : '--')).join(' ');
    console.log(`${`${r.variant}#${r.round}`.padEnd(20)} ${mem}   ${rec}   ${r.memoryFiles}   ${r.batches}   ${r.usd ?? 'n/a'}`);
  }
  if (cfg.report) {
    mkdirSync(dirname(cfg.report), { recursive: true });
    writeFileSync(cfg.report, JSON.stringify({ run: RUN, finished_at: new Date().toISOString(), facts: FACTS.map(({ id, step, depth, text, query }) => ({ id, step, depth, text, query })), results }, null, 2) + '\n');
  }
  process.exit(results.some((r) => r.error) ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
