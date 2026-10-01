import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Multica, sleep } from '../real-stack/multica.mjs';
import { OvClient } from '../../src/ov-client.mjs';
import { auditMemories } from './memory-audit.mjs';

if (process.env.MULTICA_RUN_REAL_AGENT_SMOKE !== '1') throw new Error('Explicit real-agent authorization is required');
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = process.env.MC_CLI ?? 'multica';
const env = process.env;
const pluginUrl = env.PLUGIN_URL ?? 'https://127.0.0.1:8790';
const model = env.AGENT_MODEL ?? 'openrouter/z-ai/glm-5.3-flash';
const suite = env.REAL_AGENT_SUITE ?? 'basic';
if (!['basic', 'matrix', 'quality', 'benchmark', 'delivery'].includes(suite)) throw new Error(`Unknown real-agent suite: ${suite}`);
for (const key of ['OV_ROOT_KEY', 'OVMEM_TLS_CERT', 'OVMEM_TLS_KEY', 'OPENROUTER_API_KEY']) {
  if (!env[key]) throw new Error(`${key} is required`);
}
execFileSync(cli, ['--version'], { stdio: 'pipe' });
const runtimeVersion = execFileSync('opencode', ['--version'], { encoding: 'utf8' }).trim();
const resumeState = env.REAL_AGENT_RESUME_STATE;
const previous = resumeState ? JSON.parse(readFileSync(join(resumeState, 'report.json'), 'utf8')) : null;
const finishMatrix = env.REAL_AGENT_MATRIX_PHASE === 'finish';
const recoverShared = env.REAL_AGENT_MATRIX_PHASE === 'shared';
const continueQuality = env.REAL_AGENT_QUALITY_PHASE === 'continue';
const continueBenchmark = env.REAL_AGENT_BENCHMARK_PHASE === 'continue';
if (env.REAL_AGENT_BENCHMARK_PHASE && !continueBenchmark) throw new Error('Unknown benchmark continuation phase');
if (continueBenchmark && (!previous || suite !== 'benchmark' || previous.suite !== 'benchmark')) throw new Error('Benchmark continuation requires its original isolated workspace');
if (env.REAL_AGENT_QUALITY_PHASE && !continueQuality) throw new Error('Unknown quality recovery phase');
if (continueQuality && (!previous || suite !== 'quality' || previous.suite !== 'quality')) throw new Error('Quality continuation requires its existing isolated workspace');
if (env.REAL_AGENT_MATRIX_PHASE && !finishMatrix && !recoverShared) throw new Error('Unknown matrix phase');
const stoppedAtVersionGate = previous && [previous.error, ...(previous.attempts ?? []).map(a => a.error)].some(error => error?.includes('daemon_version_unsupported'));
if ((finishMatrix || recoverShared) && (!previous || suite !== 'matrix' || previous.suite !== 'matrix')) throw new Error('Recovery phase requires an existing isolated matrix');
if (previous && !finishMatrix && !recoverShared && !continueQuality && !continueBenchmark && (suite !== 'matrix' || previous.suite !== 'matrix' || !stoppedAtVersionGate || previous.tasks?.some(t => t.entry === 'quick-create'))) {
  throw new Error('Resume requires a matrix stopped at the quick-create version gate');
}
const run = previous ? previous.platformCanary.replace(/^PLATFORM_ONLY_/, '') : Date.now().toString(36);
const state = resumeState ?? mkdtempSync(join(tmpdir(), 'ovmem-real-agent-'));
const pluginState = join(state, 'plugin');
const cliRoot = join(homedir(), '.multica');
const profile = `real-agent-${run}`;
mkdirSync(pluginState, { recursive: true }); mkdirSync(join(cliRoot, 'profiles', profile), { recursive: true });
const results = previous?.results ?? [];
const report = previous ?? { startedAt: new Date().toISOString(), state, suite, model, results, runtime: 'real OpenCode CLI via official Multica daemon' };
if (previous) {
  report.attempts ??= [];
  report.attempts.push({ finishedAt: report.finishedAt, error: report.error, resumedAt: new Date().toISOString() });
  delete report.error; delete report.finishedAt;
  if (report.model !== model) throw new Error('Resume must retain the original agent model');
}
report.profile = profile;
report.multicaCliVersion = execFileSync(cli, ['--version'], { encoding: 'utf8' }).trim();
function save() { writeFileSync(join(state, 'report.json'), JSON.stringify(report, null, 2)); }
function step(id, ok, detail) { results.push({ id, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`); save(); }
function toolResultData(message) {
  try { return typeof message.output === 'string' ? JSON.parse(message.output) : message.output; } catch { return null; }
}
function privateFile(path, value) { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }
async function wait(label, fn, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(1500); }
  throw new Error(`Timed out waiting for ${label}`);
}
console.log(`Real-agent state: ${state}`);
if (env.REAL_AGENT_STATE_POINTER) writeFileSync(env.REAL_AGENT_STATE_POINTER, state);
const mc = new Multica({ base: env.MC_BASE ?? 'http://127.0.0.1:18080', devCode: env.MC_DEV_CODE ?? '888888' });
const ov = new OvClient({ baseUrl: env.OV_BASE ?? 'http://127.0.0.1:1936' });
let daemon, plugin;
try {
  let user, ws, inst;
  if (previous) {
    const access = JSON.parse(readFileSync(join(state, 'access.json'), 'utf8'));
    const dmUserIds = [...new Set(Object.keys(JSON.parse(readFileSync(join(pluginState, 'scopes.json'), 'utf8')).scopes).filter(s => s.startsWith(`dm:${report.workspaceId}:`)).map(s => s.split(':')[3]))];
    if (!access.userId && dmUserIds.length !== 1) throw new Error('Cannot recover the isolated test member');
    user = { token: access.token, userId: access.userId ?? dmUserIds[0] }; ws = access.workspaceId;
    if (ws !== report.workspaceId) throw new Error('Resume workspace mismatch');
    const rotated = await mc.must('rotate owned test installation token', mc.call(`/api/workspaces/${ws}/plugins/${report.installationId}/token`, { method: 'POST', token: user.token, ws }));
    inst = { installationId: report.installationId, signingSecret: rotated.signing_secret };
  } else {
    user = await mc.login(`ovmem-real-agent-${run}@example.com`);
    ws = await mc.createWorkspace(user.token, { name: `Real agent memory ${run}`, slug: `real-agent-${run}`, prefix: 'RAM' });
    const pat = await mc.must('PAT', mc.call('/api/tokens', { method: 'POST', token: user.token, body: { name: `real-agent-${run}`, expires_in_days: 1 } }));
    const zipped = execFileSync('bash', ['scripts/package.sh', '--url', pluginUrl, '--with-chats-read'], { cwd: repo, encoding: 'utf8' }).match(/packaged: (\S+\.zip)/)[1];
    const pkg = await mc.must('publish package', mc.publishPlugin(user.token, ws, join(repo, zipped)));
    inst = await mc.installPlugin(user.token, ws, pkg.versions[0].id);
    report.workspaceId = ws; report.installationId = inst.installationId;
    privateFile(join(state, 'access.json'), { token: user.token, userId: user.userId, workspaceId: ws });
    privateFile(join(cliRoot, 'profiles', profile, 'config.json'), { server_url: mc.base, token: pat.token, workspace_id: ws, workspaces_root: join(state, 'workspaces') });
    privateFile(join(pluginState, 'config.json'), { extractPollIntervalMs: 1500, extractPollMaxIntervalMs: 4000, extractRedriveDelayMs: 8000 });
  }
  const pluginToken = previous ? JSON.parse(readFileSync(join(state, 'plugin-access.json'), 'utf8')).pluginToken : randomUUID();
  privateFile(join(state, 'plugin-access.json'), { pluginToken, pluginUrl });
  plugin = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env: { ...process.env, OVMEM_PORT: String(new URL(pluginUrl).port || 443), OVMEM_BIND: '127.0.0.1', OVMEM_STATE_DIR: pluginState, OVMEM_OV_BASE_URL: ov.baseUrl, OVMEM_OV_ROOT_KEY: env.OV_ROOT_KEY, OVMEM_SIGNING_SECRETS: JSON.stringify({ [inst.installationId]: { secret: inst.signingSecret, workspace_id: ws } }), OVMEM_MULTICA_API_URL: `${mc.base}/v1`, OVMEM_PLUGIN_TOKEN: pluginToken, OVMEM_TLS_CERT: env.OVMEM_TLS_CERT, OVMEM_TLS_KEY: env.OVMEM_TLS_KEY }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [plugin.stdout, plugin.stderr]) stream.on('data', data => { const log = join(state, 'plugin.log'); writeFileSync(log, data, { flag: 'a' }); });
  await wait('plugin', async () => { try { return (await fetch(`${pluginUrl}/healthz`)).ok; } catch { return false; } }, 30000);
  const observeProvider = suite === 'benchmark' || suite === 'delivery';
  const observers = observeProvider ? [`file://${repo}/deploy/observers/opencode.mjs`, `file://${repo}/e2e/real-agent/after-delivery-fault.mjs`] : [];
  privateFile(join(state, 'opencode.json'), { $schema: 'https://opencode.ai/config.json', ...(observers.length ? { plugin: observers } : {}), provider: { openrouter: { options: { apiKey: '{env:OPENROUTER_API_KEY}' } } }, model });
  const daemonEnv = { ...process.env, OPENCODE_CONFIG: join(state, 'opencode.json'), MULTICA_SERVER_URL: mc.base, MULTICA_KEEP_ENV_AFTER_TASK: '1' };
  if (observeProvider) Object.assign(daemonEnv, { OVMEM_PROVIDER_DIAGNOSTICS: '1', OVMEM_PROVIDER_DIAGNOSTICS_FILE: join(state,'opencode-provider-requests.jsonl'), OVMEM_E2E_DELIVERY_AUTHORIZED: '1', OVMEM_E2E_DELIVERY_FAULT: join(state,'delivery-fault.json') });
  daemon = spawn(cli, ['--profile', profile, 'daemon', 'start', '--foreground', '--no-auto-update', '--no-auto-reload', '--poll-interval', '2s', '--ws-claim-poll-interval', '5s', '--heartbeat-interval', '5s', '--max-concurrent-tasks', suite === 'matrix' ? '2' : '1', '--agent-timeout', suite === 'matrix' ? '8m' : '5m', '--workspaces-root', join(state, 'workspaces'), '--device-name', `ovmem-real-agent-${run}`], { cwd: state, env: daemonEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', data => writeFileSync(join(state, 'daemon-stderr.log'), data, { flag: 'a' }));
  daemon.on('exit', code => console.log(`Official daemon exited: ${code}`));
  const runtime = await wait('actual OpenCode registration', async () => {
    const data = await mc.must('runtimes', mc.call('/api/runtimes', { token: user.token, ws }));
    return (Array.isArray(data) ? data : data.runtimes ?? []).find(r => (r.type === 'opencode' || r.provider === 'opencode') && r.status === 'online');
  }, 45000);
  report.runtimeId = runtime.id; report.runtimeVersion = runtime.metadata?.version ?? runtime.metadata?.agent_version ?? runtimeVersion;
  step('runtime', true, `Official daemon discovered and registered OpenCode ${report.runtimeVersion}`);
  save();
  const canary = `PLATFORM_ONLY_${run}`;
  const installedSkills = await mc.must('installed skills', mc.call('/api/skills', { token: user.token, ws }));
  const memorySkill = (Array.isArray(installedSkills) ? installedSkills : installedSkills.skills ?? []).find(skill => skill.name === 'openviking-memory');
  if (!memorySkill) throw new Error('Installed memory skill is unavailable');
  report.skillId = memorySkill.id;
  if (continueQuality) {
    await mc.must('update owned fixture skill', mc.call(`/api/skills/${memorySkill.id}`, { method: 'PUT', token: user.token, ws, body: { content: readFileSync(join(repo, 'skills/openviking-memory/SKILL.md'), 'utf8') } }));
    report.liveSkillUpdate = { ts: new Date().toISOString(), skillId: memorySkill.id, purpose: 'Clarify business query and memory-recall versus own-space search' }; save();
  }
  const agentTemplate = { description: 'Authorized isolated real-agent memory test', instructions: `使用中文完成任务。遵循安装的 openviking-memory skill。不要创建新智能体。只有任务明确要求时，才可向该测试工作区已有智能体发送一次委派评论。不得打印环境变量、凭据、配置密钥。只读取任务目录的 AGENTS.md、平台挂载到任务目录的该 skill 及任务需要的记忆。不要全盘搜索技能文件。内部运行标记 ${canary} 只用于平台测试，不是业务事实，不要在回复或主动记忆里记录。`, skill_ids: [memorySkill.id], runtime_id: runtime.id, model, custom_env: { OPENCODE_CONFIG: join(state, 'opencode.json') }, visibility: 'workspace', max_concurrent_tasks: 1 };
  const agent = previous
    ? await mc.must('bind resumed actual agent', mc.call(`/api/agents/${report.agentId}`, { method: 'PUT', token: user.token, ws, body: { runtime_id: runtime.id } }))
    : await mc.must('create actual agent', mc.call('/api/agents', { method: 'POST', token: user.token, ws, body: { ...agentTemplate, name: `Real memory auditor ${run}` } }));
  report.agentId = agent.id; report.platformCanary = canary; save();
  const memberCall = path => mc.must(path, mc.call(path, { token: user.token, ws }));
  async function execute(title, description) {
    const issue = await mc.createIssue(user.token, ws, { title, description });
    await mc.assign(user.token, ws, issue.id, agent.id);
    let lastStatus = '';
    const task = await wait(`real agent ${issue.identifier}`, async () => {
      const tasks = await memberCall(`/api/agents/${agent.id}/tasks?include_usage=true`);
      const t = tasks.find(t => t.issue_id === issue.id);
      if (t && t.status !== lastStatus) { lastStatus = t.status; console.log(`${issue.identifier}: ${t.status}`); }
      return t && ['completed', 'failed', 'cancelled'].includes(t.status) ? t : null;
    }, 360000);
    const data = await memberCall(`/api/tasks/${task.id}/messages?limit=2000`);
    const messages = Array.isArray(data) ? data : data.messages ?? [];
    privateFile(join(state, `${issue.identifier}-transcript.json`), messages);
    const commentsData = await memberCall(`/api/issues/${issue.id}/comments`);
    const comments = (Array.isArray(commentsData) ? commentsData : commentsData.comments ?? []).filter(c => c.author_type === 'agent' && c.author_id === agent.id && c.source_task_id === task.id);
    const record = { issueId: issue.id, identifier: issue.identifier, taskId: task.id, status: task.status, output: task.result?.output ?? task.output ?? '', comments: comments.map(c => ({ id: c.id, content: c.content, sourceTaskId: c.source_task_id })), usage: task.usage, messageCount: messages.length, tools: messages.filter(m => m.type === 'tool_use').map(m => m.tool), input: description };
    report.tasks ??= []; report.tasks.push(record); save();
    if (task.status !== 'completed') throw new Error(`Real task ${issue.identifier} ended ${task.status}: ${String(task.error ?? task.output ?? '').slice(0, 600)}`);
    return { issue, task, messages, record };
  }
  if (suite === 'matrix' || suite === 'quality' || suite === 'benchmark' || suite === 'delivery') {
    const ctx = { mc, ov, user, ws, agent, agentTemplate, state, pluginState, pluginUrl, pluginToken, canary, run, report, step, save, wait, privateFile, toolResultData, resume: !!previous, finish: finishMatrix };
    if (suite === 'delivery') {
      const { runDeliveryCheck } = await import('./delivery-check.mjs');
      await runDeliveryCheck(ctx);
    } else if (suite === 'benchmark') {
      const { runBenchmark } = await import('./benchmark.mjs');
      await runBenchmark(ctx);
    } else if (suite === 'quality') {
      const { runQuality } = await import('./quality.mjs');
      await runQuality(ctx);
    } else if (recoverShared) {
      const { recoverSharedMatrix } = await import('./recover-shared.mjs');
      await recoverSharedMatrix(ctx);
    } else {
      const { runMatrix } = await import('./matrix.mjs');
      await runMatrix(ctx);
    }
  } else {
  const first = await execute('海棠迁移方案确认', '这是隔离联调任务。海棠迁移项目已确认：使用 RocketMQ；每月预算 3800 元；双写持续两周；死信队列超过 10000 条时告警。请先调用 memory-recall 查询既有约定。必须使用 read 工具实际读取当前任务工作目录的 AGENTS.md（这是本任务验收项），确认平台操作方式，但不要复述平台说明。把上述已确认方案通过 memory-remember 记录为一条可复用的业务记忆，kind 选 cases。最后以简短中文确认四项约定，并按平台流程提交最终任务回复。不要把平台说明或内部运行标记写入业务记忆。无需修改代码。');
  step('actual-tools', first.record.tools.some(t => /memory.*recall/.test(t)) && first.record.tools.some(t => /memory.*remember/.test(t)), `Actual tool calls: ${first.record.tools.join(', ')}`);
  const memoryResults = first.messages.filter(m => m.type === 'tool_result' && /memory.*(recall|remember)/.test(m.tool ?? ''));
  step('successful-memory-tools', memoryResults.length >= 2 && memoryResults.every(m => toolResultData(m)?.status === 'ok'), 'Actual agent memory calls completed through the signed hook proxy');
  const scopes = () => JSON.parse(readFileSync(join(pluginState, 'scopes.json'), 'utf8')).scopes;
  const statuses = () => existsSync(join(pluginState, 'archives.jsonl')) ? readFileSync(join(pluginState, 'archives.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  const extraction = await wait('real task extraction', async () => statuses().find(e => e.type === 'extraction' && e.ref === first.task.id && e.extraction === 'done'), 240000);
  step('automatic-extraction', !!extraction, 'Actual completed task automatically archived and extracted');
  report.firstExtraction = extraction;
  const ownArchiveScope = scopes()[extraction.scope];
  const archiveUri = `viking://user/${ownArchiveScope.userId}/sessions/${extraction.session_id}/history/archive_001/messages.jsonl`;
  const archivedMessages = (await ov.readContent(ownArchiveScope.apiKey, archiveUri, { limit: 5000 })).content ?? '';
  report.archiveAudit = { uri: archiveUri, characters: archivedMessages.length, containsRuntimeBanner: archivedMessages.includes('# Multica Agent Runtime'), containsCanary: archivedMessages.includes(canary) };
  privateFile(join(state, 'actual-archive.json'), { messages: archivedMessages });
  step('archive-prompt-hygiene', !report.archiveAudit.containsRuntimeBanner && !report.archiveAudit.containsCanary, 'Checked actual OpenViking archive for runtime prompt contamination');
  const activeIndex = await wait('active memory index', async () => statuses().find(e => e.type === 'index-memory' && (e.indexing === 'done' || e.extraction === 'done')) ?? statuses().find(e => e.type === 'extraction' && e.record === 'index-memory' && e.extraction === 'done'), 90000).catch(() => null);
  step('active-memory-index', !!activeIndex, 'Real agent public memory was indexed asynchronously');
  const archive = statuses().find(e => e.ref === first.task.id && e.session_id);
  report.firstArchive = archive;
  const second = await execute('新任务查询海棠既有方案', '海棠迁移项目之前已经确定哪些消息队列、预算、双写周期和死信告警约定？请按 openviking-memory skill 召回，在回复里列出四项约定，附上记忆来源 URI。这里没有重新提供那些数值，请以实际召回证据为准；没有证据的项如实说明。不必记录新记忆，不要修改代码。');
  const reply = [second.record.output, ...second.record.comments.map(c => c.content), ...second.messages.filter(m => m.type === 'text').map(m => m.content)].join('\n');
  const recallResult = second.messages.filter(m => m.type === 'tool_result' && /memory.*recall/.test(m.tool ?? '')).map(toolResultData).find(data => data?.status === 'ok');
  step('recall-bound-to-run', recallResult?.result?.run?.bound === true, 'Memory recall was bound to the actual new task');
  step('cross-task-recall', /RocketMQ/i.test(reply) && /3800/.test(reply) && /两周|2\s*周|two weeks|14\s*天/.test(reply) && /10000|10,000|1\s*万/.test(reply) && recallResult?.result?.entries?.some(entry => second.record.comments.some(comment => comment.content.includes(entry.uri))), 'New real task recovered all four facts and cited a Viking URI');
  const diagnostic = await execute('实际读取平台说明的归档隔离诊断', '这是明确授权的隔离诊断任务。必须实际调用 read 工具读取当前任务工作目录的 AGENTS.md，这一步是验收要求。即使平台已在上下文提供该文件，也仍需要本次 read 工具的实际读取记录。不要复述文件内容或内部运行标记，不要记录任何记忆，不要搜索其他目录。读取后通过平台流程提交简短最终回复“平台说明读取诊断完成”。不需要其他业务工作或代码修改。');
  const third = await execute('无答案问题', '梧桐项目的值班负责人和预定上线日期分别是什么？请先调用 memory-recall 搜索，再根据证据回答。这是一个独立项目，没有与海棠有关联；如果没有记忆，明确说明，不要编造人员或日期。不必记录新记忆，不要修改代码。');
  const negative = [third.record.output, ...third.record.comments.map(c => c.content), ...third.messages.filter(m => m.type === 'text').map(m => m.content)].join('\n');
  step('no-answer', /没有|未找到|无相关|未提供|无法确认|暂无/.test(negative), 'Actual agent acknowledged missing evidence');
  // Audit all actual archived session messages and extracted memory files.
  for (const t of [second.task, diagnostic.task, third.task]) await wait('remaining extraction', async () => statuses().find(e => e.type === 'extraction' && e.ref === t.id && e.extraction === 'done'), 240000);
  const audit = await auditMemories({ ov, scopes: Object.fromEntries(Object.entries(scopes()).filter(([scope]) => scope.split(':')[1] === ws)), canary });
  report.memoryAudit = audit;
  const diagnosticExtraction = statuses().find(e => e.type === 'extraction' && e.ref === diagnostic.task.id && e.extraction === 'done');
  const diagnosticScope = scopes()[diagnosticExtraction.scope];
  const diagnosticUri = `viking://user/${diagnosticScope.userId}/sessions/${diagnosticExtraction.session_id}/history/archive_001/messages.jsonl`;
  const diagnosticArchive = (await ov.readContent(diagnosticScope.apiKey, diagnosticUri, { limit: 5000 })).content ?? '';
  report.diagnosticArchiveAudit = { uri: diagnosticUri, characters: diagnosticArchive.length, containsRuntimeBanner: diagnosticArchive.includes('# Multica Agent Runtime'), containsCanary: diagnosticArchive.includes(canary) };
  step('runtime-read-archive-hygiene', !report.diagnosticArchiveAudit.containsRuntimeBanner && !report.diagnosticArchiveAudit.containsCanary, 'Actual platform-file read was filtered from the OpenViking archive');
  const serialized = JSON.stringify(diagnostic.messages);
  report.transcriptContainsRuntimeBanner = serialized.includes('# Multica Agent Runtime');
  report.transcriptContainsCanary = serialized.includes(canary);
  step('runtime-read-exercised', report.transcriptContainsRuntimeBanner && report.transcriptContainsCanary, 'Actual agent read injected runtime instructions before archive filtering');
  step('distilled-prompt-hygiene', audit.some(a => a.files > 0) && audit.every(a => a.complete && !a.containsRuntimeBanner && !a.containsPlatformCanary && !a.containsPlatformGuidance), `Transcript runtime banner: ${report.transcriptContainsRuntimeBanner}; inspected ${audit.reduce((n, a) => n + a.files, 0)} extracted files including peers`);
  step('memory-quality', audit.every(a => a.complete && !a.qualityFindings.length), 'Checked reusable memories for known execution controls and retrieval-outcome facts');
  }
  report.currentResults = [...new Map(results.map(result => [result.id, result])).values()];
  if (report.currentResults.some(result => !result.ok)) process.exitCode = 1;
} catch (error) {
  report.error = error.message; console.error(error.message); process.exitCode = 1;
} finally {
  if (daemon && daemon.exitCode === null) { daemon.kill('SIGTERM'); await Promise.race([new Promise(r => daemon.once('exit', r)), sleep(15000)]); }
  if (plugin && plugin.exitCode === null) { plugin.kill('SIGTERM'); await Promise.race([new Promise(r => plugin.once('exit', r)), sleep(15000)]); }
  report.finishedAt = new Date().toISOString(); save();
  if (env.REPORT_FILE) writeFileSync(env.REPORT_FILE, JSON.stringify(report, null, 2)); console.log(`Saved report: ${join(state, 'report.json')}`);
}
