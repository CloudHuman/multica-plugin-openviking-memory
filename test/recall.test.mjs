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

test('recall merges scopes, drops stubs and duplicates, ranks and caps', async () => {
  const ov = await startFakeOv();
  try {
    const { client, registry, provision } = await bootRegistry(ov);
    const taskScope = scopeKey('task', FIXTURE_WS, FIXTURE_ISSUE_ID);
    const agentScope = scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_A);
    const sharedScope = scopeKey('shared', FIXTURE_WS);

    const taskRec = await provision(taskScope);
    const agentRec = await provision(agentScope);
    await provision(sharedScope);

    await client.writeContent(taskRec.apiKey, { uri: 'memories/events/选型结论.md', content: '推荐 RocketMQ 顺序性满足' });
    await client.writeContent(taskRec.apiKey, { uri: 'memories/.overview.md', content: 'namespace stub should be filtered' });
    await client.writeContent(agentRec.apiKey, { uri: 'memories/events/选型结论.md', content: 'same uri in agent space (dedup by uri, best score wins)' });
    await client.writeContent(agentRec.apiKey, { uri: 'memories/experiences/注释规范.md', content: '代码注释使用中文' });

    const result = await recallFromScopes({
      ov: client, registry,
      scopeKeys: [taskScope, agentScope, sharedScope],
      query: '选型', entries: 5,
    });
    assert.equal(result.entries.some((e) => e.uri.endsWith('.overview.md')), false);
    const uris = result.entries.map((e) => e.uri);
    assert.equal(new Set(uris).size, uris.length);
    assert.equal(uris.includes('memories/events/选型结论.md'), true);
    assert.ok(result.entries.every((e) => e.scope && e.source));
    // L2 content attached
    const hit = result.entries.find((e) => e.uri === 'memories/events/选型结论.md');
    assert.ok(hit.content);

    // cap
    const capped = await recallFromScopes({ ov: client, registry, scopeKeys: [taskScope, agentScope], query: 'e', entries: 1 });
    assert.equal(capped.entries.length, 1);
  } finally {
    await ov.stop();
  }
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
    assert.equal(result.entries.length, 0);
    const block = renderRecallBlock(result);
    assert.equal(block, '');
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
    await client.writeContent(rec.apiKey, { uri: 'memories/experiences/提交规范.md', content: '提交信息使用约定式提交格式' });
    const result = await recallFromScopes({ ov: client, registry, scopeKeys: [sharedScope], query: '提交规范', entries: 5 });
    const block = renderRecallBlock(result);
    assert.match(block, /reference evidence/);
    assert.match(block, /提交信息使用约定式提交格式/);
    assert.match(block, /viking|memories\//);
  } finally {
    await ov.stop();
  }
});
