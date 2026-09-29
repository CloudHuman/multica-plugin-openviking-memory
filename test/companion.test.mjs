import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { OvClient } from '../src/ov-client.mjs';
import { ScopeRegistry, scopeKey } from '../src/scopes.mjs';
import { JobQueue } from '../src/queue.mjs';
import { makeArchiveHandler } from '../src/pipeline.mjs';
import { Ledger, ArchiveStatusLog } from '../src/ledger.mjs';
import { createApp, buildRequestListener } from '../src/server.mjs';
import { startFakeOv, tempStateDir, postJson, FIXTURE_WS, FIXTURE_AGENT_A, FIXTURE_AGENT_B, FIXTURE_USER } from './helpers.mjs';
import { sleep } from '../src/util.mjs';
import { createServer } from 'node:http';

async function boot({ ov }) {
  const stateDir = tempStateDir();
  const cfg = {
    ...loadConfig({}, { stateDir }),
    ovBaseUrl: ov.baseUrl, ovRootKey: 'root',
    signingSecret: 'whsec_' + 'ab'.repeat(32), pluginToken: 'tok',
    extractWatchTimeoutMs: 1500, extractWatchIntervalMs: 30,
    reextractAttempts: 1, reextractBaseDelayMs: 10,
    recallEntries: 5, recallPerScopeLimit: 10, recallContentMaxChars: 2400,
    includeThinking: false, dropToolPrefixes: [],
  };
  const ovClient = new OvClient({ baseUrl: ov.baseUrl, timeoutMs: 3000 });
  const registry = new ScopeRegistry({ ov: ovClient, rootKey: 'root', stateDir, log: () => {} });
  const ledger = new Ledger({ stateDir });
  const statusLog = new ArchiveStatusLog({ stateDir });
  const queue = new JobQueue({
    stateDir, handler: makeArchiveHandler({ ov: ovClient, registry, statusLog, cfg, log: () => {} }),
    maxAttempts: 3, baseDelayMs: 5, pollMs: 10, log: () => {},
  });
  queue.start();
  const app = createApp({ cfg, ov: ovClient, registry, queue, ledger, statusLog });
  const handler = await buildRequestListener({ cfg, app });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, registry, queue };
}

const AUTH = { headers: { Authorization: 'Bearer tok' } };

test('companion: chat archives into the DM pair scope, isolated from other pairs and agents', async () => {
  const ov = await startFakeOv();
  let h;
  try {
    h = await boot({ ov });
    const chatRes = await postJson(h.port, '/internal/events', {
      type: 'chat.completed', version: 1, workspace_id: FIXTURE_WS, delivery_id: 'd-1',
      payload: {
        chat_ref: 'chat-42', agent_id: FIXTURE_AGENT_A, user_id: FIXTURE_USER,
        messages: [
          { role: 'user', content: '以后这个项目的代码注释都用中文' },
          { role: 'assistant', content: '好的,记住了,后续我会遵循这个约定。' },
        ],
      },
    }, AUTH);
    assert.equal(chatRes.json.result.status, 'queued');
    await sleep(300);

    const dmScope = scopeKey('dm', FIXTURE_WS, FIXTURE_AGENT_A, FIXTURE_USER);
    const dmRec = h.registry.get(dmScope);
    assert.ok(dmRec, 'dm pair scope provisioned');
    const session = ov.sessionsOf(dmRec.apiKey).get('mc-chat-chat-42');
    assert.ok(session, 'chat session archived in dm space');
    assert.equal(session.messages[0].peer_id, FIXTURE_USER);
    assert.match(session.messages[0].content, /代码注释都用中文/);

    // another pair / another agent has no such session or content
    const dmOther = scopeKey('dm', FIXTURE_WS, FIXTURE_AGENT_B, FIXTURE_USER);
    assert.equal(h.registry.get(dmOther), null);
    const agentScope = scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_A);
    const agentRec = h.registry.get(agentScope);
    assert.equal(agentRec, null);

    // companion recall for the same pair sees it; a different pair does not
    const r1 = await postJson(h.port, '/internal/recall', {
      workspace_id: FIXTURE_WS, agent_id: FIXTURE_AGENT_A, user_id: FIXTURE_USER, kind: 'chat',
      query: '注释',
    }, AUTH);
    assert.equal(r1.status, 200);
    assert.ok(r1.json.result.injected_block.length > 0, 'recall block rendered for the owning pair');
    const r2 = await postJson(h.port, '/internal/recall', {
      workspace_id: FIXTURE_WS, agent_id: FIXTURE_AGENT_B, user_id: FIXTURE_USER, kind: 'chat',
      query: '注释',
    }, AUTH);
    assert.deepEqual(r2.json.result.entries, [], 'other pair sees nothing');

    // redelivery is deduped
    const dup = await postJson(h.port, '/internal/events', {
      type: 'chat.completed', version: 1, workspace_id: FIXTURE_WS, delivery_id: 'd-1',
      payload: { chat_ref: 'chat-42', agent_id: FIXTURE_AGENT_A, user_id: FIXTURE_USER, messages: [] },
    }, AUTH);
    assert.equal(dup.json.result.status, 'duplicate');
  } finally {
    await h.queue.stop({ drainMs: 500 }).catch(() => {});
    h && await new Promise((r) => h.server.close(r));
    await ov.stop();
  }
});

test('companion: appended input and delegation handoff land in their scopes', async () => {
  const ov = await startFakeOv();
  let h;
  try {
    h = await boot({ ov });
    await postJson(h.port, '/internal/events', {
      type: 'task.input_appended', version: 1, workspace_id: FIXTURE_WS, delivery_id: 'd-2',
      payload: { append_id: 'ap-9', task_id: 'run-7', issue_id: 'i-77', content: '补充:给出回滚方案', delivered: true },
    }, AUTH);
    await postJson(h.port, '/internal/events', {
      type: 'delegation.handoff', version: 1, workspace_id: FIXTURE_WS, delivery_id: 'd-3',
      payload: { handoff_id: 'h-3', from_agent_id: FIXTURE_AGENT_A, to_agent_id: FIXTURE_AGENT_B, content: '请复核选型结论与预算约束' },
    }, AUTH);
    await sleep(350);

    const taskScope = scopeKey('task', FIXTURE_WS, 'i-77');
    const taskRec = h.registry.get(taskScope);
    assert.ok(taskRec);
    const appendSession = ov.sessionsOf(taskRec.apiKey).get('mc-append-ap-9');
    assert.ok(appendSession);
    assert.match(appendSession.messages[0].content, /已确认投递/);

    const delegScope = scopeKey('delegation', FIXTURE_WS, FIXTURE_AGENT_A, FIXTURE_AGENT_B);
    const delegRec = h.registry.get(delegScope);
    assert.ok(delegRec);
    const delegSession = ov.sessionsOf(delegRec.apiKey).get('mc-deleg-h-3');
    assert.ok(delegSession);
    assert.equal(delegSession.messages[0].peer_id, FIXTURE_AGENT_A);
  } finally {
    await h.queue.stop({ drainMs: 500 }).catch(() => {});
    h && await new Promise((r) => h.server.close(r));
    await ov.stop();
  }
});

test('companion endpoints reject missing bearer token', async () => {
  const ov = await startFakeOv();
  let h;
  try {
    h = await boot({ ov });
    const r = await postJson(h.port, '/internal/recall', { workspace_id: FIXTURE_WS, query: 'x' });
    assert.equal(r.status, 401);
    const r2 = await postJson(h.port, '/internal/events', { type: 'chat.completed' });
    assert.equal(r2.status, 401);
  } finally {
    await h.queue.stop({ drainMs: 500 }).catch(() => {});
    h && await new Promise((r) => h.server.close(r));
    await ov.stop();
  }
});
