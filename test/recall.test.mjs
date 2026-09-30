import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recallFromScopes, renderRecallBlock } from '../src/recall.mjs';
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
