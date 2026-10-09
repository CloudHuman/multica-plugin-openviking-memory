import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeKey } from '../src/scopes.mjs';
import { startFakeOv, postJson, FIXTURE_WS, FIXTURE_ISSUE_ID, FIXTURE_AGENT_A, FIXTURE_AGENT_B, FIXTURE_USER } from './helpers.mjs';
import { bootService, waitFor } from './harness.mjs';

// The companion API: for multica builds that push chat turns, appended input
// and delegation handoffs to the plugin directly (bearer-authenticated).

const chatTurn = (deliveryId, messages, agentId = FIXTURE_AGENT_A) => ({
  type: 'chat.completed', version: 1, workspace_id: FIXTURE_WS, delivery_id: deliveryId,
  payload: { chat_ref: 'chat-42', agent_id: agentId, user_id: FIXTURE_USER, messages },
});

test('companion: each chat turn archives into the DM pair scope, isolated from other pairs and agents', async () => {
  const ov = await startFakeOv();
  const svc = await bootService({ ov });
  try {
    const first = await svc.admin('/internal/events', chatTurn('d-1', [
      { role: 'user', content: '以后这个项目的代码注释都用中文' },
      { role: 'assistant', content: '好的,记住了,后续我会遵循这个约定。' },
    ]));
    assert.equal(first.json.result.status, 'queued', first.text);

    const dmScope = scopeKey('dm', FIXTURE_WS, FIXTURE_AGENT_A, FIXTURE_USER);
    const dmRec = await waitFor(() => svc.registry.get(dmScope), { label: 'dm pair scope provisioned' });
    await waitFor(() => ov.archivedOf(dmRec.apiKey, 'mc-chat-chat-42-d-1').length, { label: 'turn 1 archived' });
    const turn1 = ov.archivedOf(dmRec.apiKey, 'mc-chat-chat-42-d-1');
    assert.equal(turn1[0].peer_id, FIXTURE_USER);
    assert.match(turn1[0].content, /代码注释都用中文/);

    // A later turn of the same chat is its own record, not a duplicate.
    const second = await svc.admin('/internal/events', chatTurn('d-2', [
      { role: 'user', content: '另外,接口命名统一用驼峰' },
      { role: 'assistant', content: '明白。' },
    ]));
    assert.equal(second.json.result.status, 'queued', second.text);
    await waitFor(() => ov.archivedOf(dmRec.apiKey, 'mc-chat-chat-42-d-2').length, { label: 'turn 2 archived' });

    // Redelivery of a turn is deduped.
    const dup = await svc.admin('/internal/events', chatTurn('d-1', []));
    assert.equal(dup.json.result.status, 'duplicate');

    // Another pair / the agent's public space got nothing.
    assert.equal(svc.registry.get(scopeKey('dm', FIXTURE_WS, FIXTURE_AGENT_B, FIXTURE_USER)), null);
    assert.equal(svc.registry.get(scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_A)), null);

    // Recall for the owning pair sees the distilled turn; another pair does not.
    await waitFor(() => [...ov.filesOf(dmRec.apiKey).keys()].some((u) => u.includes('/memories/')), { label: 'distilled' });
    const mine = await svc.admin('/internal/recall', { workspace_id: FIXTURE_WS, agent_id: FIXTURE_AGENT_A, user_id: FIXTURE_USER, kind: 'chat', query: '注释' });
    assert.equal(mine.status, 200, mine.text);
    assert.match(mine.json.result.injected_block, /代码注释都用中文/);
    const theirs = await svc.admin('/internal/recall', { workspace_id: FIXTURE_WS, agent_id: FIXTURE_AGENT_B, user_id: FIXTURE_USER, kind: 'chat', query: '注释' });
    assert.deepEqual(theirs.json.result.entries, []);
  } finally {
    await svc.stop();
    await ov.stop();
  }
});

test('companion: appended input and delegation handoff land in their scopes', async () => {
  const ov = await startFakeOv();
  const svc = await bootService({ ov });
  try {
    await svc.admin('/internal/events', {
      type: 'task.input_appended', version: 1, workspace_id: FIXTURE_WS, delivery_id: 'd-2',
      payload: { append_id: 'ap-9', task_id: 'run-7', issue_id: FIXTURE_ISSUE_ID, content: '补充:给出回滚方案', delivered: true },
    });
    await svc.admin('/internal/events', {
      type: 'delegation.handoff', version: 1, workspace_id: FIXTURE_WS, delivery_id: 'd-3',
      payload: { handoff_id: 'h-3', from_agent_id: FIXTURE_AGENT_A, to_agent_id: FIXTURE_AGENT_B, content: '请复核选型结论与预算约束' },
    });

    const taskRec = await waitFor(() => svc.registry.get(scopeKey('task', FIXTURE_WS, FIXTURE_ISSUE_ID)), { label: 'task scope' });
    await waitFor(() => ov.archivedOf(taskRec.apiKey, 'mc-append-ap-9').length, { label: 'append archived' });
    assert.match(ov.archivedOf(taskRec.apiKey, 'mc-append-ap-9')[0].content, /已确认投递/);

    const delegRec = await waitFor(() => svc.registry.get(scopeKey('delegation', FIXTURE_WS, FIXTURE_AGENT_A, FIXTURE_AGENT_B)), { label: 'delegation scope' });
    await waitFor(() => ov.archivedOf(delegRec.apiKey, 'mc-deleg-h-3').length, { label: 'handoff archived' });
    assert.equal(ov.archivedOf(delegRec.apiKey, 'mc-deleg-h-3')[0].peer_id, FIXTURE_AGENT_A);
  } finally {
    await svc.stop();
    await ov.stop();
  }
});

test('companion: malformed events are refused with 400, not queued', async () => {
  const ov = await startFakeOv();
  const svc = await bootService({ ov });
  try {
    const noAgent = await svc.admin('/internal/events', {
      type: 'chat.completed', workspace_id: FIXTURE_WS, delivery_id: 'x1', payload: { chat_ref: 'c', user_id: FIXTURE_USER, messages: [] },
    });
    assert.equal(noAgent.status, 400);
    assert.match(noAgent.json.error.message, /agent_id/);
    const noIssue = await svc.admin('/internal/events', {
      type: 'task.input_appended', workspace_id: FIXTURE_WS, delivery_id: 'x2', payload: { append_id: 'a', content: 'x' },
    });
    assert.equal(noIssue.status, 400);
    const unknown = await svc.admin('/internal/events', { type: 'nope', workspace_id: FIXTURE_WS, payload: {} });
    assert.equal(unknown.status, 400);
    assert.equal(svc.queue.jobs.size, 0);
  } finally {
    await svc.stop();
    await ov.stop();
  }
});

test('companion endpoints reject a missing bearer token', async () => {
  const ov = await startFakeOv();
  const svc = await bootService({ ov });
  try {
    const r = await postJson(svc.port, '/internal/recall', { workspace_id: FIXTURE_WS, query: 'x' });
    assert.equal(r.status, 401);
    const r2 = await postJson(svc.port, '/internal/events', { type: 'chat.completed' });
    assert.equal(r2.status, 401);
  } finally {
    await svc.stop();
    await ov.stop();
  }
});
