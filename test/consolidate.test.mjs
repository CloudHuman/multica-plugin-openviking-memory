import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consolidateShared } from '../src/consolidate.mjs';
import { OvClient } from '../src/ov-client.mjs';
import { ScopeRegistry, scopeKey } from '../src/scopes.mjs';
import { startFakeOv, tempStateDir, FIXTURE_WS, FIXTURE_AGENT_A, FIXTURE_AGENT_B } from './helpers.mjs';

test('consolidate promotes reusable kinds into shared with provenance, idempotently', async () => {
  const ovF = await startFakeOv();
  try {
    const ov = new OvClient({ baseUrl: ovF.baseUrl });
    const registry = new ScopeRegistry({ ov, rootKey: 'root', stateDir: tempStateDir(), log: () => {} });
    const agentRec = await registry.ensureScope(scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_A), { workspaceId: FIXTURE_WS });

    const U = (p) => `viking://user/${agentRec.userId}/${p}`;
    await ov.writeContent(agentRec.apiKey, { uri: U('memories/experiences/选型框架.md'), content: '中间件选型固定用五维框架:顺序性/事务/死信/生态/成本,并给出灰度与回滚方案。' });
    await ov.writeContent(agentRec.apiKey, { uri: U('memories/preferences/注释规范.md'), content: '代码注释一律使用中文,对外 API 命名保持驼峰,错误码统一放在响应头。' });
    await ov.writeContent(agentRec.apiKey, { uri: U('memories/events/噪音事件.md'), content: '一次运行完成的事件记录,不应晋升。' });

    const stateDir = tempStateDir();
    const r1 = await consolidateShared({ ov, registry, workspaceId: FIXTURE_WS, stateDir, log: () => {} });
    assert.equal(r1.promoted.length, 2, 'experiences+preferences promoted, events skipped');
    assert.ok(r1.promoted.every((p) => p.from.startsWith('agent:')));
    assert.ok(r1.session_id.startsWith('mc-consolidate-'));

    // The promotion session landed in the SHARED space (native extraction path).
    const sharedRec = registry.get(scopeKey('shared', FIXTURE_WS));
    const sharedSessions = ovF.sessionsOf(sharedRec.apiKey);
    assert.ok(sharedSessions.has(r1.session_id));
    const archived = ovF.archivedOf(sharedRec.apiKey, r1.session_id);
    assert.equal(archived.length, 2, 'committed: both promotions reached the archive');
    assert.match(archived[0].content, /共享记忆晋升 #1/);
    assert.match(archived[0].content, /五维框架/);
    assert.ok(r1.extraction_task, 'the commit started an extraction task');

    // Idempotent: rerun promotes nothing new.
    const r2 = await consolidateShared({ ov, registry, workspaceId: FIXTURE_WS, stateDir, log: () => {} });
    assert.equal(r2.promoted.length, 0);
    assert.equal(ovF.sessionsOf(sharedRec.apiKey).size, 1);

    // A memory with the same file name in another space is a different memory.
    const agentB = await registry.ensureScope(scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_B), { workspaceId: FIXTURE_WS });
    await ov.writeContent(agentB.apiKey, { uri: `viking://user/${agentB.userId}/memories/experiences/选型框架.md`, content: '另一个智能体的同名经验:压测先行,指标先定义清楚再比较候选方案。' });
    const r3 = await consolidateShared({ ov, registry, workspaceId: FIXTURE_WS, stateDir, log: () => {} });
    assert.deepEqual(r3.promoted.map((p) => p.from), [scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_B)]);
  } finally {
    await ovF.stop();
  }
});
