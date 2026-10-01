import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { consolidateShared } from '../src/consolidate.mjs';
import { scopeKey } from '../src/scopes.mjs';
import { startFakeOv, FIXTURE_WS, FIXTURE_AGENT_A, FIXTURE_AGENT_B } from './helpers.mjs';
import { bootService, waitFor } from './harness.mjs';

test('shared promotion is durable and recovers a failed extraction after restart', async () => {
  const ovF = await startFakeOv({ taskBehavior: 'fail-first' });
  let svc = await bootService({ ov: ovF });
  try {
    const rec = await svc.registry.ensureScope(scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_A), { workspaceId: FIXTURE_WS });
    await svc.ovClient.writeContent(rec.apiKey, { uri: `viking://user/${rec.userId}/memories/cases/共享方案.md`, content: '项目采用 NATS JetStream，每月成本不超过 2450 元；这是需要共享的业务约定。' });
    const response = await svc.admin('/admin/consolidate', { workspace_id: FIXTURE_WS });
    assert.equal(response.status, 200, response.text);
    const result = response.json.result;
    assert.equal(result.status, 'queued');
    assert.ok(result.job_id, 'durable job exists before promotion is acknowledged');
    const stateDir = svc.stateDir;
    await svc.stop();
    svc = await bootService({ ov: ovF, stateDir });
    await waitFor(() => svc.statusLog.recent({ limit: 100 }).some(e => e.record === 'consolidate' && e.extraction === 'done'), { label: 'shared extraction recovered' });
    const events = svc.statusLog.recent({ limit: 100 }).filter(e => e.record === 'consolidate');
    assert.ok(events.some(e => e.extraction === 'redriven'));
    const shared = svc.registry.get(scopeKey('shared', FIXTURE_WS));
    assert.ok(ovF.sessionsOf(shared.apiKey).has(`${result.session_id}-r1`));
    const hits = await svc.ovClient.search(shared.apiKey, { query: 'NATS', limit: 5 });
    assert.ok(hits.memories.length > 0, 'the recovered promotion is searchable');
    const repeated = await svc.admin('/admin/consolidate', { workspace_id: FIXTURE_WS });
    assert.equal(repeated.json.result.promoted.length, 0, 'the durable promotion remains idempotent');
  } finally { await svc.stop(); await ovF.stop(); }
});

test('consolidate promotes reusable kinds into shared with provenance, idempotently', async () => {
  const ovF = await startFakeOv();
  const svc = await bootService({ ov: ovF });
  try {
    const { ovClient: ov, registry, queue, stateDir } = svc;
    const agentRec = await registry.ensureScope(scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_A), { workspaceId: FIXTURE_WS });

    const U = (p) => `viking://user/${agentRec.userId}/${p}`;
    await ov.writeContent(agentRec.apiKey, { uri: U('memories/experiences/选型框架.md'), content: '中间件选型固定用五维框架:顺序性/事务/死信/生态/成本,并给出灰度与回滚方案。' });
    await ov.writeContent(agentRec.apiKey, { uri: U('memories/preferences/注释规范.md'), content: '代码注释一律使用中文,对外 API 命名保持驼峰,错误码统一放在响应头。' });
    await ov.writeContent(agentRec.apiKey, { uri: U('memories/events/噪音事件.md'), content: '一次运行完成的事件记录,不应晋升。' });

    const r1 = await consolidateShared({ ov, registry, queue, workspaceId: FIXTURE_WS, stateDir, log: () => {} });
    assert.equal(r1.promoted.length, 2, 'experiences+preferences promoted, events skipped');
    assert.ok(r1.promoted.every((p) => p.from.startsWith('agent:')));
    assert.ok(r1.session_id.startsWith('mc-consolidate-'));

    // The promotion session landed in the SHARED space (native extraction path).
    const sharedRec = registry.get(scopeKey('shared', FIXTURE_WS));
    await waitFor(() => ovF.archivedOf(sharedRec.apiKey, r1.session_id).length === 2);
    const sharedSessions = ovF.sessionsOf(sharedRec.apiKey);
    assert.ok(sharedSessions.has(r1.session_id));
    const archived = ovF.archivedOf(sharedRec.apiKey, r1.session_id);
    assert.equal(archived.length, 2, 'committed: both promotions reached the archive');
    assert.match(archived[0].content, /共享记忆晋升 #1/);
    assert.match(archived[0].content, /五维框架/);
    assert.ok(r1.job_id, 'the promotion is durably queued');

    // Idempotent: rerun promotes nothing new.
    const r2 = await consolidateShared({ ov, registry, queue, workspaceId: FIXTURE_WS, stateDir, log: () => {} });
    assert.equal(r2.promoted.length, 0);
    assert.equal(ovF.sessionsOf(sharedRec.apiKey).size, 1);

    // A memory with the same file name in another space is a different memory.
    const agentB = await registry.ensureScope(scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_B), { workspaceId: FIXTURE_WS });
    await ov.writeContent(agentB.apiKey, { uri: `viking://user/${agentB.userId}/memories/experiences/选型框架.md`, content: '另一个智能体的同名经验:压测先行,指标先定义清楚再比较候选方案。' });
    const r3 = await consolidateShared({ ov, registry, queue, workspaceId: FIXTURE_WS, stateDir, log: () => {} });
    assert.deepEqual(r3.promoted.map((p) => p.from), [scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_B)]);
  } finally {
    await svc.stop();
    await ovF.stop();
  }
});

test('failed queue admission leaves promotion available for retry', async () => {
  const ovF = await startFakeOv();
  const svc = await bootService({ ov: ovF });
  try {
    const rec = await svc.registry.ensureScope(scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_A), { workspaceId: FIXTURE_WS });
    await svc.ovClient.writeContent(rec.apiKey, { uri: `viking://user/${rec.userId}/memories/cases/队列恢复.md`, content: '发布回归窗口必须保留七天，回滚演练最长三小时，测试确认后才可晋升共享。' });
    const enqueue = svc.queue.enqueue.bind(svc.queue);
    svc.queue.enqueue = () => { throw new Error('disk admission failed'); };
    const rejected = await svc.admin('/admin/consolidate', { workspace_id: FIXTURE_WS });
    assert.equal(rejected.status, 500);
    assert.equal(existsSync(`${svc.stateDir}/consolidated.json`), false);
    svc.queue.enqueue = enqueue;
    const retried = await svc.admin('/admin/consolidate', { workspace_id: FIXTURE_WS });
    assert.equal(retried.json.result.promoted.length, 1);
    assert.ok(retried.json.result.job_id);
  } finally { await svc.stop(); await ovF.stop(); }
});

test('sharing rejects known run controls, ignores stubs and deduplicates exact content across paths', async () => {
  const ovF = await startFakeOv();
  const svc = await bootService({ ov: ovF });
  try {
    const rec = await svc.registry.ensureScope(scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_A), { workspaceId: FIXTURE_WS });
    const base = `viking://user/${rec.userId}/memories`;
    const fact = '# 青岚仓库\n- 采用 NATS JetStream。\n- 每月预算上限 2450 元。';
    for (const [path, content] of [
      ['entities/代码仓库/青岚.md', fact], ['entities/项目/青岚.md', fact],
      ['preferences/任务要求.md', '任务回复须基于 memory-recall 召回的实际证据，并引用来源 URI。未经明确要求不主动记录记忆，不修改代码。'],
      ['entities/项目/.overview.md', fact],
    ]) await svc.ovClient.writeContent(rec.apiKey, { uri: `${base}/${path}`, content });
    const result = await svc.admin('/admin/consolidate', { workspace_id: FIXTURE_WS });
    assert.equal(result.json.result.promoted.length, 1);
    assert.ok(result.json.result.skipped.some(s => s.reasons.includes('execution-control')));
    assert.ok(result.json.result.skipped.some(s => s.reasons.includes('duplicate-content')));
    const retry = await svc.admin('/admin/consolidate', { workspace_id: FIXTURE_WS });
    assert.equal(retry.json.result.promoted.length, 0);
  } finally { await svc.stop(); await ovF.stop(); }
});

test('an explicit update to the same entity URI is promoted once with the new value', async () => {
  const ovF = await startFakeOv();
  const svc = await bootService({ ov: ovF });
  try {
    const rec = await svc.registry.ensureScope(scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_A), { workspaceId: FIXTURE_WS });
    const uri = `viking://user/${rec.userId}/memories/entities/项目/苍鹭.md`;
    const write = budget => svc.ovClient.writeContent(rec.apiKey, { uri, content: `# 苍鹭发布\n- 使用 Apache Pulsar。\n- 月度预算 ${budget} 元。\n- 双写持续五天。`, mode: 'overwrite' });
    await write(7600);
    const first = await svc.admin('/admin/consolidate', { workspace_id: FIXTURE_WS });
    await write(8100);
    const second = await svc.admin('/admin/consolidate', { workspace_id: FIXTURE_WS });
    assert.equal(second.json.result.promoted.length, 1);
    assert.notEqual(second.json.result.session_id, first.json.result.session_id);
    const job = svc.queue.jobs.get(second.json.result.job_id);
    assert.match(job.payload.messages[0].content, /8100/);
    assert.doesNotMatch(job.payload.messages[0].content, /7600/);
    assert.match(job.payload.messages[0].content, /来源 URI:/);
    const repeated = await svc.admin('/admin/consolidate', { workspace_id: FIXTURE_WS });
    assert.equal(repeated.json.result.promoted.length, 0);
    // Reusing a past value is still a new current-version update, not a
    // duplicate of the old native session or its already-completed queue job.
    await write(7600);
    const rollback = await svc.admin('/admin/consolidate', { workspace_id: FIXTURE_WS });
    assert.equal(rollback.json.result.promoted.length, 1);
    assert.notEqual(rollback.json.result.session_id, first.json.result.session_id);
    await write(8100);
    const restored = await svc.admin('/admin/consolidate', { workspace_id: FIXTURE_WS });
    assert.equal(restored.json.result.promoted.length, 1);
    assert.notEqual(restored.json.result.session_id, second.json.result.session_id);
  } finally { await svc.stop(); await ovF.stop(); }
});

test('legacy URI-only receipts get a safe current-content backfill once', async () => {
  const ovF = await startFakeOv();
  const svc = await bootService({ ov: ovF });
  try {
    const scope = scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_A);
    const rec = await svc.registry.ensureScope(scope, { workspaceId: FIXTURE_WS });
    const uri = `viking://user/${rec.userId}/memories/entities/项目/苍鹭.md`;
    await svc.ovClient.writeContent(rec.apiKey, { uri, content: '# 苍鹭发布\n- 使用 Apache Pulsar。\n- 月度预算 8100 元。\n- 双写持续五天。' });
    writeFileSync(`${svc.stateDir}/consolidated.json`, JSON.stringify({ files: { [`${scope}|${uri}`]: '2026-09-30T00:00:00Z' } }));
    const backfill = await svc.admin('/admin/consolidate', { workspace_id: FIXTURE_WS });
    assert.equal(backfill.json.result.promoted.length, 1);
    const repeated = await svc.admin('/admin/consolidate', { workspace_id: FIXTURE_WS });
    assert.equal(repeated.json.result.promoted.length, 0);
  } finally { await svc.stop(); await ovF.stop(); }
});

test('identical content in two workspaces is promoted independently', async () => {
  const ovF = await startFakeOv();
  const svc = await bootService({ ov: ovF });
  try {
    const content = '# 青岚仓库\n- 采用 NATS JetStream。\n- 每月预算上限 2450 元。';
    for (const workspaceId of [FIXTURE_WS, '99999999-1111-4111-8111-222222222222']) {
      const rec = await svc.registry.ensureScope(scopeKey('agent', workspaceId, FIXTURE_AGENT_A), { workspaceId });
      await svc.ovClient.writeContent(rec.apiKey, { uri: `viking://user/${rec.userId}/memories/entities/项目/青岚.md`, content });
      const result = await consolidateShared({ ov: svc.ovClient, registry: svc.registry, queue: svc.queue, workspaceId, stateDir: svc.stateDir });
      assert.equal(result.promoted.length, 1, 'another workspace cannot suppress this workspace\'s promotion');
    }
  } finally { await svc.stop(); await ovF.stop(); }
});

test('a per-scope promotion limit does not skip other agents', async () => {
  const ovF = await startFakeOv();
  const svc = await bootService({ ov: ovF });
  try {
    for (const id of [FIXTURE_AGENT_A, FIXTURE_AGENT_B]) {
      const rec = await svc.registry.ensureScope(scopeKey('agent', FIXTURE_WS, id), { workspaceId: FIXTURE_WS });
      for (const name of ['第一条', '第二条']) await svc.ovClient.writeContent(rec.apiKey, { uri: `viking://user/${rec.userId}/memories/cases/${name}.md`, content: `${name}业务结论：发布窗口必须保留七天，回滚演练最长三小时，使用独立指标复核。` });
    }
    const result = await svc.admin('/admin/consolidate', { workspace_id: FIXTURE_WS, per_scope_limit: 1 });
    assert.equal(result.json.result.promoted.length, 2);
    assert.equal(new Set(result.json.result.promoted.map(p => p.from)).size, 2);
  } finally { await svc.stop(); await ovF.stop(); }
});

test('a failed receipt write cannot duplicate accepted memories when new files arrive', async () => {
  const ovF = await startFakeOv();
  const svc = await bootService({ ov: ovF });
  try {
    const rec = await svc.registry.ensureScope(scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_A), { workspaceId: FIXTURE_WS });
    const write = name => svc.ovClient.writeContent(rec.apiKey, { uri: `viking://user/${rec.userId}/memories/cases/${name}.md`, content: `${name}业务约定：发布回归窗口保留七天，回滚演练最长三小时。` });
    await write('原有记忆');
    mkdirSync(`${svc.stateDir}/consolidated.json`);
    const failed = await svc.admin('/admin/consolidate', { workspace_id: FIXTURE_WS });
    assert.equal(failed.status, 500);
    assert.equal([...svc.queue.jobs.values()].filter(j => j.type === 'consolidate').length, 1);
    rmdirSync(`${svc.stateDir}/consolidated.json`);
    await write('新到记忆');
    const retried = await svc.admin('/admin/consolidate', { workspace_id: FIXTURE_WS });
    assert.equal(retried.json.result.promoted.length, 1);
    assert.equal(retried.json.result.promoted[0].file, '新到记忆.md');
  } finally { await svc.stop(); await ovF.stop(); }
});

test('legacy failed shared sessions can be replayed, with failure and scope validation', async () => {
  const ovF = await startFakeOv({ taskBehavior: 'fail-first' });
  const svc = await bootService({ ov: ovF });
  try {
    const rec = await svc.registry.ensureScope(scopeKey('shared', FIXTURE_WS), { workspaceId: FIXTURE_WS });
    const sid = 'mc-consolidate-legacy-failed';
    const messages = [{ role: 'user', content: '青岚项目采用 NATS JetStream，每月成本上限为 2450 元。' }];
    await svc.ovClient.createSession(rec.apiKey, { sessionId: sid });
    await svc.ovClient.addMessages(rec.apiKey, sid, messages);
    const committed = await svc.ovClient.commitSession(rec.apiKey, sid);
    await svc.ovClient.getTask(rec.apiKey, committed.task_id);
    assert.equal((await svc.ovClient.getTask(rec.apiKey, committed.task_id)).status, 'failed');
    ovF.filesOf(rec.apiKey).set(`${committed.archive_uri}/messages.jsonl`, messages.map(m => JSON.stringify({ role: m.role, parts: [{ type: 'text', text: m.content }] })).join('\n'));
    const bad = await svc.admin('/admin/consolidate', { workspace_id: FIXTURE_WS, replay_session_id: '../../private' });
    assert.equal(bad.status, 400);
    const replay = await svc.admin('/admin/consolidate', { workspace_id: FIXTURE_WS, replay_session_id: sid });
    assert.equal(replay.status, 200, replay.text);
    await waitFor(() => svc.statusLog.recent({ limit: 100 }).some(e => e.ref === sid && e.extraction === 'done'));
    assert.equal(ovF.archivedOf(rec.apiKey, `${sid}-r1`)[0].content, messages[0].content);
    const successful = await svc.admin('/admin/consolidate', { workspace_id: FIXTURE_WS, replay_session_id: `${sid}-r1` });
    assert.equal(successful.status, 409);
    const missing = await svc.admin('/admin/consolidate', { workspace_id: FIXTURE_WS, replay_session_id: 'mc-consolidate-other-workspace' });
    assert.equal(missing.status, 409);
  } finally { await svc.stop(); await ovF.stop(); }
});

test('concurrent promotion requests with different limits cannot duplicate source files', async () => {
  const ovF = await startFakeOv();
  const svc = await bootService({ ov: ovF });
  try {
    const rec = await svc.registry.ensureScope(scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_A), { workspaceId: FIXTURE_WS });
    for (const name of ['并发一', '并发二']) await svc.ovClient.writeContent(rec.apiKey, { uri: `viking://user/${rec.userId}/memories/cases/${name}.md`, content: `${name}业务约定：发布回归窗口保留七天，回滚演练最长三小时，须按审批计划复核。` });
    const results = await Promise.all([1, 2].map(limit => svc.admin('/admin/consolidate', { workspace_id: FIXTURE_WS, per_scope_limit: limit })));
    assert.ok(results.every(r => r.status === 200));
    const promoted = results.flatMap(r => r.json.result.promoted);
    assert.equal(promoted.length, 2);
    assert.equal(new Set(promoted.map(p => `${p.from}|${p.file}`)).size, 2);
  } finally { await svc.stop(); await ovF.stop(); }
});
