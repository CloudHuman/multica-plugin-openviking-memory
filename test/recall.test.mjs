import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recallFromScopes, renderRecallBlock, isOpaqueMemoryQuery, mentionsIdentifier, withoutIdentifiers } from '../src/recall.mjs';
import { OvClient } from '../src/ov-client.mjs';
import { ScopeRegistry, scopeKey } from '../src/scopes.mjs';
import { startFakeOv, tempStateDir, FIXTURE_WS, FIXTURE_ISSUE_ID, FIXTURE_AGENT_A } from './helpers.mjs';

async function bootRegistry(ov) {
  const client = new OvClient({ baseUrl: ov.baseUrl });
  const stateDir = tempStateDir();
  const registry = new ScopeRegistry({ ov: client, rootKey: 'root', stateDir, log: () => {} });
  const provision = async (k) => registry.ensureScope(k, { workspaceId: FIXTURE_WS });
  return { client, registry, provision };
}

// Memories live under each space's own user root, as OV writes them.
const memUri = (rec, path) => `viking://user/${rec.userId}/memories/${path}`;

test('only identifier-only queries are eligible for business-context recovery', () => {
  const id = '11111111-2222-4333-8444-555555555555';
  assert.equal(isOpaqueMemoryQuery(`${id} task context related memories`), true);
  assert.equal(isOpaqueMemoryQuery(`issue ${id} context and prior decisions`), true);
  assert.equal(isOpaqueMemoryQuery('MUL-123'), true);
  assert.equal(isOpaqueMemoryQuery(`${id} 原先的负责人是谁`), false);
  assert.equal(isOpaqueMemoryQuery('苍鹭项目的预算与双写周期'), false);
  // English stopwords and Chinese generic words around an identifier carry no intent either.
  assert.equal(isOpaqueMemoryQuery(`issue ${id} context or related decisions for this task`), true);
  assert.equal(isOpaqueMemoryQuery(`任务 ${id} 相关记忆`), true);
  assert.equal(isOpaqueMemoryQuery('MUL-123 相关约定和决策'), true);
  assert.equal(isOpaqueMemoryQuery('MUL-123 预算'), false);
});

test('run identifiers are recognised as whole tokens and can be removed from a query', () => {
  const id = '11111111-2222-4333-8444-555555555555';
  assert.equal(mentionsIdentifier(`issue ${id.toUpperCase()} context`, [id]), true);
  assert.equal(mentionsIdentifier('MUL-8 的预算', ['MUL-8']), true);
  assert.equal(mentionsIdentifier('MUL-80 的预算', ['MUL-8']), false);
  assert.equal(mentionsIdentifier('XMUL-8 的预算', ['MUL-8']), false);
  assert.equal(mentionsIdentifier('海棠迁移预算', [id, 'MUL-8', null, undefined]), false);
  assert.equal(withoutIdentifiers(`issue ${id} context for MUL-8 海棠`, [id, 'MUL-8']), 'issue context for 海棠');
});

test('recall merges scopes, drops stubs, ranks and caps, and reads each hit from its first line', async () => {
  const ov = await startFakeOv();
  try {
    const { client, registry, provision } = await bootRegistry(ov);
    const taskScope = scopeKey('task', FIXTURE_WS, FIXTURE_ISSUE_ID);
    const agentScope = scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_A);
    const sharedScope = scopeKey('shared', FIXTURE_WS);

    const taskRec = await provision(taskScope);
    const agentRec = await provision(agentScope);
    await provision(sharedScope);

    const decision = memUri(taskRec, 'events/选型结论.md');
    await client.writeContent(taskRec.apiKey, { uri: decision, content: '选型结论:推荐 RocketMQ\n顺序性满足,事务消息原生支持。' });
    await client.writeContent(taskRec.apiKey, { uri: memUri(taskRec, '.overview.md'), content: 'namespace stub should be filtered' });
    await client.writeContent(agentRec.apiKey, { uri: memUri(agentRec, 'experiences/注释规范.md'), content: '代码注释使用中文' });

    const result = await recallFromScopes({
      ov: client, registry,
      scopeKeys: [taskScope, agentScope, sharedScope],
      query: '选型', entries: 5,
    });
    assert.equal(result.entries.some((e) => e.uri.endsWith('.overview.md')), false, 'stubs dropped');
    assert.ok(result.entries.every((e) => e.scope && e.source));
    const hit = result.entries.find((e) => e.uri === decision);
    assert.ok(hit, JSON.stringify(result.entries));
    assert.equal(hit.scope, taskScope);
    assert.equal(result.entries[0].uri, decision, 'the matching memory ranks first');
    // The first line is part of the content: reads start at offset 0.
    assert.match(hit.content, /^选型结论:推荐 RocketMQ/);
    // Multica keeps an 8 KB preview of each tool result: the searched spaces come before the long entries.
    assert.deepEqual(Object.keys(result), ['query', 'scopesSearched', 'entries']);

    const capped = await recallFromScopes({ ov: client, registry, scopeKeys: [taskScope, agentScope], query: 'e', entries: 1 });
    assert.equal(capped.entries.length, 1);
  } finally {
    await ov.stop();
  }
});

test('the same memory seen through two scopes collapses to its best-scoring, higher-priority hit', async () => {
  const hitsByKey = {
    kTask: [{ context_type: 'memory', uri: 'viking://user/u/memories/events/a.md', score: 0.5, level: 2 }],
    kShared: [
      { context_type: 'memory', uri: 'viking://user/u/memories/events/a.md', score: 0.5, level: 2 },
      { context_type: 'resource', uri: 'viking://resources/doc.md', score: 0.99, level: 2 },
    ],
  };
  const recs = { [scopeKey('task', FIXTURE_WS, 'i')]: { apiKey: 'kTask' }, [scopeKey('shared', FIXTURE_WS)]: { apiKey: 'kShared' } };
  const fakeOv = {
    async search(key) { return { memories: hitsByKey[key] }; },
    async readContent() { return { content: 'body' }; },
  };
  const result = await recallFromScopes({ ov: fakeOv, registry: { get: (k) => recs[k] ?? null }, scopeKeys: Object.keys(recs), query: 'q' });
  assert.equal(result.entries.length, 1, 'duplicates collapse and non-memory hits are not candidates');
  assert.equal(result.entries[0].scope, scopeKey('task', FIXTURE_WS, 'i'), 'ties go to the higher-priority scope');
});

test('an event OV filed twice (own memories/ and a peer\'s memories/) is one recall entry', async () => {
  const own = 'viking://user/u/memories/events/2026/09/30/选型结论.md';
  const peer = 'viking://user/u/peers/member-1/memories/events/2026/09/30/选型结论.md';
  const fakeOv = {
    async search() {
      return { memories: [
        { context_type: 'memory', uri: peer, score: 0.969, level: 2 },
        { context_type: 'memory', uri: own, score: 0.969, level: 2 },
        { context_type: 'memory', uri: 'viking://user/u/peers/member-1/memories/events/2026/09/30/告警阈值.md', score: 0.8, level: 2 },
      ] };
    },
    async readContent() { return { content: 'body' }; },
  };
  const scope = scopeKey('task', FIXTURE_WS, 'i');
  const result = await recallFromScopes({ ov: fakeOv, registry: { get: () => ({ apiKey: 'k' }) }, scopeKeys: [scope], query: 'q' });
  assert.deepEqual(result.entries.map((e) => e.uri), [own, 'viking://user/u/peers/member-1/memories/events/2026/09/30/告警阈值.md'],
    'the own copy wins a tie; a memory only the peer folder holds stays');
});

test('recall returns what answered by its deadline and reports the rest as timed out', async () => {
  const fast = 'viking://user/u1/memories/events/fast.md';
  const taskScope = scopeKey('task', FIXTURE_WS, 'i');
  const agentScope = scopeKey('agent', FIXTURE_WS, 'a');
  const recs = { [taskScope]: { apiKey: 'kFast' }, [agentScope]: { apiKey: 'kSlow' } };
  const hang = () => new Promise((r) => setTimeout(r, 5_000).unref());
  const fakeOv = {
    async search(key) {
      if (key === 'kSlow') await hang(); // the model provider is having a slow minute
      return { memories: key === 'kFast' ? [{ context_type: 'memory', uri: fast, score: 0.8, level: 2, abstract: 'fast abstract' }] : [] };
    },
    readContent: async () => ({ content: 'body' }),
  };
  const registry = { get: (k) => recs[k] ?? null };
  let started = Date.now();
  const result = await recallFromScopes({ ov: fakeOv, registry, scopeKeys: [taskScope, agentScope], query: 'q', deadline: started + 400, contentReserveMs: 100 });
  assert.ok(Date.now() - started < 1_000, 'the slow scope is not waited for');
  assert.deepEqual(result.entries.map((e) => [e.uri, e.content]), [[fast, 'body']]);
  assert.equal(result.scopesSearched.find((s) => s.scope === agentScope).timedOut, true);
  assert.equal(result.scopesSearched.find((s) => s.scope === taskScope).timedOut, undefined);

  // A content read that does not come back in time leaves the abstract.
  started = Date.now();
  const slowRead = await recallFromScopes({
    ov: { ...fakeOv, readContent: async () => { await hang(); return { content: 'late' }; } },
    registry, scopeKeys: [taskScope], query: 'q', deadline: started + 300, contentReserveMs: 100,
  });
  assert.ok(Date.now() - started < 1_000);
  assert.deepEqual(slowRead.entries.map((e) => [e.content, e.abstract]), [[null, 'fast abstract']]);
});

test('recall reports unprovisioned scopes as skipped, never fails', async () => {
  const ov = await startFakeOv();
  try {
    const { client, registry } = await bootRegistry(ov);
    const result = await recallFromScopes({
      ov: client, registry,
      scopeKeys: [scopeKey('dm', FIXTURE_WS, 'a', 'u')], // never provisioned
      query: 'anything', entries: 5,
    });
    assert.deepEqual(result.entries, []);
    assert.equal(result.scopesSearched[0].skipped, 'not-provisioned');
    assert.equal(renderRecallBlock(result), '');
  } finally {
    await ov.stop();
  }
});

test('recall fills slots after filtering controls and exact copies, keeping current and historical budgets', async () => {
  const scope = scopeKey('shared', FIXTURE_WS);
  const base = 'viking://user/u/memories';
  const files = [
    [`${base}/preferences/临时要求.md`, '未经明确要求不主动记录记忆，不修改代码；任务回复须基于 memory-recall 召回的实际证据，并引用来源 URI。'],
    [`${base}/entities/项目/苍鹭.md`, '# 苍鹭发布\n- 使用 Apache Pulsar。\n- 月度预算 8100 元。\n- 双写持续五天。'],
    [`${base}/entities/仓库/苍鹭.md`, '# 苍鹭发布\n- 使用 Apache Pulsar。\n- 月度预算 8100 元。\n- 双写持续五天。'],
    [`${base}/cases/历史决定.md`, '# 苍鹭发布历史决定\n- 2026-09-30 月度预算 7600 元，2026-10-01 正式调整为 8100 元。'],
  ];
  const ov = {
    search: async () => ({ memories: files.map(([uri], i) => ({ uri, context_type: 'memory', score: 1 - i / 10 })) }),
    readContent: async (_key, uri) => ({ content: files.find(f => f[0] === uri)[1] }),
  };
  const result = await recallFromScopes({ ov, registry: { get: () => ({ apiKey: 'key' }) }, scopeKeys: [scope], query: '苍鹭预算', entries: 2 });
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].duplicate_sources.length, 1);
  assert.match(result.entries[0].content, /8100/);
  assert.match(result.entries[1].content, /7600/);
  assert.ok(result.entries.every(e => !/未经明确要求|memory-recall/.test(e.content)));
});

test('renderRecallBlock produces a bounded injected-context block', async () => {
  const ov = await startFakeOv();
  try {
    const { client, registry, provision } = await bootRegistry(ov);
    const sharedScope = scopeKey('shared', FIXTURE_WS);
    const rec = await provision(sharedScope);
    await client.writeContent(rec.apiKey, { uri: memUri(rec, 'experiences/提交规范.md'), content: '提交信息使用约定式提交格式' });
    const result = await recallFromScopes({ ov: client, registry, scopeKeys: [sharedScope], query: '提交规范', entries: 5 });
    const block = renderRecallBlock(result);
    assert.match(block, /reference evidence/);
    assert.match(block, /提交信息使用约定式提交格式/);
    assert.match(block, /viking:\/\/user\/[^/]+\/memories\//);

    const tiny = renderRecallBlock(result, { maxChars: 80 });
    assert.ok(tiny.length <= 80, 'entries that do not fit are left out');
  } finally {
    await ov.stop();
  }
});
