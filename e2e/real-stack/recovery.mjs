#!/usr/bin/env node
/**
 * Background reads off the happy path, against a REAL patched multica and a
 * REAL OpenViking (mock model is enough; nothing here judges extraction):
 *
 *   V1  the documented single-installation setup: OVMEM_SIGNING_SECRET +
 *       OVMEM_MULTICA_TOKEN; a finished run is read in the background
 *   V2  the plugin process is killed (SIGKILL) while a long run is being read
 *       or archived; after a restart on the same state directory the run is
 *       archived whole, in one commit
 *   V3  multica restarts while a long run is being read (MC_RESTART_CMD); the
 *       read is retried and the run archived whole
 *   V4  the install token is rotated: the next read fails without retrying
 *       and says how to fix it; after the plugin gets the new token,
 *       POST /admin/redrive reads the run
 *   V5  a run that fails for good (after multica's own retry) is read in the
 *       background and archived with its failure
 *
 * Env: OV_ROOT_KEY, OVMEM_TLS_CERT, OVMEM_TLS_KEY, PLUGIN_CA (required);
 *      MC_BASE, MC_DEV_CODE, OV_BASE, PLUGIN_URL (as in run.mjs);
 *      MC_RESTART_CMD  shell command that restarts multica and returns once it
 *                      answers again (V3 is skipped without it)
 *      REPORT_FILE=…   write the results as JSON
 */
import { spawn, execFileSync, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
  restartCmd: env.MC_RESTART_CMD ?? '',
  report: env.REPORT_FILE ?? '',
};
const pluginPort = Number(new URL(cfg.pluginUrl).port || 443);
const RUN = Date.now().toString(36);
const ADMIN = `recovery-admin-${randomUUID()}`;

const results = [];
function step(id, name, ok, detail = '') {
  results.push({ id, name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${name}${detail ? ` — ${detail}` : ''}`);
}
async function waitFor(label, fn, { timeoutMs = 120_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

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
const admin = (path, body) => pluginCall(path, { method: body ? 'POST' : 'GET', body, headers: { Authorization: `Bearer ${ADMIN}` } });

/** The plugin as an operator runs it: one installation, configured by env vars. */
class Plugin {
  constructor(stateDir) {
    this.stateDir = stateDir;
    this.log = [];
  }

  async start({ secret, token }) {
    this.proc = spawn(process.execPath, [join(root, 'src', 'server.mjs')], {
      env: {
        PATH: env.PATH, HOME: env.HOME,
        OVMEM_PORT: String(pluginPort), OVMEM_BIND: '127.0.0.1', OVMEM_STATE_DIR: this.stateDir,
        OVMEM_OV_BASE_URL: cfg.ovBase, OVMEM_OV_ROOT_KEY: cfg.ovRootKey,
        OVMEM_SIGNING_SECRET: secret, OVMEM_MULTICA_TOKEN: token,
        OVMEM_MULTICA_API_URL: `${cfg.mcBase}/v1`, OVMEM_PLUGIN_TOKEN: ADMIN,
        OVMEM_TLS_CERT: cfg.tlsCert, OVMEM_TLS_KEY: cfg.tlsKey,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (d) => this.log.push(d.toString()));
    this.proc.stderr.on('data', (d) => this.log.push(d.toString()));
    this.exited = new Promise((r) => this.proc.once('exit', r));
    await waitFor('plugin healthz', async () => (await pluginCall('/healthz')).json?.result?.ov?.healthy, { timeoutMs: 30_000 });
  }

  async stop(signal = 'SIGTERM') {
    if (!this.proc || this.proc.exitCode !== null) return;
    this.proc.kill(signal);
    await this.exited;
  }

  statusLog() {
    const f = join(this.stateDir, 'archives.jsonl');
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  }

  entry(pred) { return this.statusLog().find(pred); }
}

function buildPackage() {
  const out = execFileSync('bash', [join(root, 'scripts', 'package.sh'), '--url', cfg.pluginUrl, '--with-chats-read'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const m = out.match(/packaged: (\S+\.zip)/);
  if (!m) throw new Error(`package.sh printed no package path:\n${out}`);
  return join(root, m[1]);
}

function transcript(n, last) {
  const t = [];
  for (let i = 0; i < n; i++) {
    t.push({ seq: t.length + 1, type: 'text', content: `第 ${i} 步：检查分片 orders-${i}。` });
    t.push({ seq: t.length + 1, type: 'tool_use', tool: 'bash', input: { command: `kubectl logs orders-${i} --tail=50` } });
    t.push({ seq: t.length + 1, type: 'tool_result', tool: 'bash', output: `orders-${i}: retries=5 dlq=7d\n`.repeat(20) });
  }
  t.push({ seq: t.length + 1, type: 'text', content: last });
  return t;
}

async function ovSession(scopes, scopeKey, sessionId) {
  const rec = scopes[scopeKey];
  const r = await fetch(`${cfg.ovBase}/api/v1/sessions/${encodeURIComponent(sessionId)}`, { headers: { Authorization: `Bearer ${rec.apiKey}` } });
  return (await r.json())?.result ?? null;
}

async function main() {
  for (const [k, v] of Object.entries({ OV_ROOT_KEY: cfg.ovRootKey, OVMEM_TLS_CERT: cfg.tlsCert, OVMEM_TLS_KEY: cfg.tlsKey, PLUGIN_CA: cfg.pluginCa })) {
    if (!v) {
      console.error(`${k} is required (see e2e/real-stack/README.md)`);
      process.exit(2);
    }
  }
  const mc = new Multica({ base: cfg.mcBase, devCode: cfg.devCode });
  const zip = buildPackage();
  const u = await mc.login(`ovmem-recovery-${RUN}@example.com`);
  const ws = await mc.createWorkspace(u.token, { name: `OV recovery ${RUN}`, slug: `ovrec-${RUN}`, prefix: 'OVR' });
  const pub = await mc.publishPlugin(u.token, ws, zip);
  if (pub.status >= 300) throw new Error(`publish: ${pub.status} ${pub.text.slice(0, 300)} (a patched multica is required)`);
  const inst = await mc.installPlugin(u.token, ws, pub.json.versions?.[0]?.id ?? pub.json.version?.id ?? pub.json.version_id);
  const plugin = new Plugin(mkdtempSync(join(tmpdir(), 'ovmem-recovery-')));
  let token = inst.installationToken;
  let daemon;
  try {
    await plugin.start({ secret: inst.signingSecret, token });
    daemon = await mc.daemon(u.token, ws);
    const agent = await daemon.createAgent(`recovery-${RUN}`);
    const runOn = async (title, messages, { finish = 'complete' } = {}) => {
      const issue = await mc.createIssue(u.token, ws, { title, description: '巡检 orders 服务分片。' });
      await mc.assign(u.token, ws, issue.id, agent.id);
      const run = await daemon.claimAndStart(agent.id, (t) => t.issue_id === issue.id);
      for (let i = 0; i < messages.length; i += 200) await daemon.report(run.id, messages.slice(i, i + 200));
      if (finish === 'complete') await daemon.complete(run.id, messages.at(-1).content);
      return { issue, run };
    };
    const archivedRun = (runId, timeoutMs = 180_000) => waitFor(`run ${runId} archived`, async () => {
      const acc = plugin.entry((e) => e.ref === runId && e.type === 'accepted' && e.kind);
      const pending = plugin.entry((e) => e.ref === runId && e.extraction === 'pending');
      return acc && pending ? { acc, pending } : null;
    }, { timeoutMs });

    // V1 ------------------------------------------------------------------
    const v1 = transcript(5, '结论：灰度先双写两周。');
    const r1 = await runOn(`V1 单安装配置 ${RUN}`, v1);
    const reg1 = await waitFor('run registered', async () => plugin.entry((e) => e.ref === r1.run.id && e.fetch === 'background'));
    const a1 = await archivedRun(r1.run.id);
    step('V1', 'OVMEM_SIGNING_SECRET + OVMEM_MULTICA_TOKEN: the hook registers the run and the background read archives it whole',
      Boolean(reg1) && a1.acc.completeness === 'complete' && a1.pending.messages === v1.length + 1,
      `completeness=${a1.acc.completeness} archived=${a1.pending.messages} (transcript ${v1.length})`);

    // V2 ------------------------------------------------------------------
    const v2 = transcript(1000, '结论：V2 的 1000 个分片全部合规。');
    const r2 = await runOn(`V2 插件崩溃 ${RUN}`, v2);
    await waitFor('run registered', async () => plugin.entry((e) => e.ref === r2.run.id && e.fetch === 'background'));
    await sleep(300);
    await plugin.stop('SIGKILL');
    const journal = readFileSync(join(plugin.stateDir, 'queue.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const lastState = (type) => journal.filter((j) => j.job?.type === type && j.job?.payload?.refId === r2.run.id).at(-1)?.job?.status ?? 'absent';
    const atKill = `fetch-run ${lastState('fetch-run')}, archive-run ${lastState('archive-run')}`;
    await plugin.start({ secret: inst.signingSecret, token });
    const a2 = await archivedRun(r2.run.id);
    const scopes2 = JSON.parse(readFileSync(join(plugin.stateDir, 'scopes.json'), 'utf8')).scopes;
    const s2 = await ovSession(scopes2, `task:${ws}:${r2.issue.id}`, `mc-task-${r2.run.id}`);
    step('V2', 'plugin killed mid-read: after a restart on the same state the run is archived whole, in one commit',
      a2.acc.completeness === 'complete' && a2.pending.messages === v2.length + 1 && s2?.commit_count === 1,
      `at kill: ${atKill}; completeness=${a2.acc.completeness} archived=${a2.pending.messages} commits=${s2?.commit_count}`);

    // V3 ------------------------------------------------------------------
    if (cfg.restartCmd) {
      const v3 = transcript(1000, '结论：V3 的 1000 个分片全部合规。');
      const r3 = await runOn(`V3 Multica 重启 ${RUN}`, v3);
      await waitFor('run registered', async () => plugin.entry((e) => e.ref === r3.run.id && e.fetch === 'background'));
      execSync(cfg.restartCmd, { stdio: 'inherit', shell: '/bin/bash' });
      const a3 = await archivedRun(r3.run.id, 300_000);
      const fetchJob = (await admin('/admin/status')).json?.result?.queue_recent?.find((j) => j.type === 'fetch-run' && j.ref === r3.run.id);
      step('V3', 'multica restarted mid-read: the read is retried and the run archived whole',
        a3.acc.completeness === 'complete' && a3.pending.messages === v3.length + 1,
        `completeness=${a3.acc.completeness} archived=${a3.pending.messages} fetch attempts=${fetchJob?.attempts ?? '?'}`);
    } else {
      step('V3', 'multica restart mid-read', true, 'skipped: MC_RESTART_CMD not set');
    }

    // V4 ------------------------------------------------------------------
    const rot = await mc.must('rotate token', mc.call(`/api/workspaces/${ws}/plugins/${inst.installationId}/token`, { method: 'POST', token: u.token }));
    const v4 = transcript(5, '结论：V4 轮换后补读成功。');
    const r4 = await runOn(`V4 token 轮换 ${RUN}`, v4);
    const failed = await waitFor('read refused', async () => (await admin('/admin/status')).json?.result?.queue_recent
      ?.find((j) => j.type === 'fetch-run' && j.ref === r4.run.id && j.status === 'failed'));
    const hint = failed.last_error.match(/POST \/admin\/redrive (\{.*\})/);
    await plugin.stop();
    token = rot.token;
    await plugin.start({ secret: rot.signing_secret ?? inst.signingSecret, token });
    const redrive = hint ? await admin('/admin/redrive', JSON.parse(hint[1])) : null;
    const a4 = await archivedRun(r4.run.id);
    step('V4', 'rotated token: the read fails once with how to fix it; with the new token /admin/redrive archives the run',
      failed.attempts === 1 && Boolean(hint) && redrive?.status === 200 && a4.acc.completeness === 'complete'
        && rot.signing_secret === inst.signingSecret,
      `attempts=${failed.attempts} redrive=${redrive?.status} completeness=${a4.acc.completeness} signing secret unchanged=${rot.signing_secret === inst.signingSecret}`);

    // V5 ------------------------------------------------------------------
    const v5 = transcript(3, '执行失败：kubectl 无权限访问 orders 命名空间。');
    const r5 = await runOn(`V5 失败的运行 ${RUN}`, v5, { finish: 'none' });
    let failedRun = r5.run;
    for (let attempt = 0; attempt < 3; attempt++) {
      await mc.must('fail task', mc.call(`/api/daemon/tasks/${failedRun.id}/fail`, { method: 'POST', token: u.token, ws, body: { error: 'kubectl: forbidden', failure_reason: 'agent_error' } }));
      // Multica may retry the run as a new task; fail that one too.
      const retry = await daemon.claimAndStart(agent.id, (t) => t.issue_id === r5.issue.id, { timeoutMs: 4_000 }).catch(() => null);
      if (!retry) break;
      await daemon.report(retry.id, v5);
      failedRun = retry;
    }
    const a5 = await archivedRun(failedRun.id);
    const skippedRetries = plugin.statusLog().filter((e) => e.type === 'skipped' && /intermediate failure/.test(e.reason ?? '')).length;
    step('V5', 'a run that fails for good is read in the background and archived with its failure',
      a5.acc.completeness === 'complete' && a5.acc.event === 'task.failed',
      `event=${a5.acc.event} completeness=${a5.acc.completeness} intermediate failures skipped=${skippedRetries}`);
  } catch (err) {
    step('ERR', 'unexpected failure', false, err.message);
    console.error(plugin.log.join('').slice(-3000));
  } finally {
    daemon?.stop();
    await plugin.stop();
  }

  const failedSteps = results.filter((r) => !r.ok);
  console.log(`\nRECOVERY RESULT: ${results.length - failedSteps.length}/${results.length} steps passed`);
  if (cfg.report) {
    mkdirSync(dirname(cfg.report), { recursive: true });
    writeFileSync(cfg.report, JSON.stringify({ run: RUN, finished_at: new Date().toISOString(), results }, null, 2) + '\n');
  }
  process.exit(failedSteps.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
