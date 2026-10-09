import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scopeKey, resolveReadScopes, resolveArchiveScope, accountIdFor, userIdFor, ScopeRegistry, runScopes,
} from '../src/scopes.mjs';
import { OvClient } from '../src/ov-client.mjs';
import { startFakeOv, tempStateDir, fixtureTask, FIXTURE_WS, FIXTURE_ISSUE_ID, FIXTURE_AGENT_A, FIXTURE_AGENT_B, FIXTURE_USER } from './helpers.mjs';

test('read-scope matrix mirrors the functional spec', () => {
  const ws = FIXTURE_WS;
  assert.deepEqual(
    resolveReadScopes({ workspaceId: ws, agentId: FIXTURE_AGENT_A, issueId: FIXTURE_ISSUE_ID, kind: 'task' }),
    [`task:${ws}:${FIXTURE_ISSUE_ID}`, `agent:${ws}:${FIXTURE_AGENT_A}`, `shared:${ws}`],
  );
  assert.deepEqual(
    resolveReadScopes({ workspaceId: ws, agentId: FIXTURE_AGENT_A, userId: FIXTURE_USER, kind: 'chat' }),
    [`dm:${ws}:${FIXTURE_AGENT_A}:${FIXTURE_USER}`, `agent:${ws}:${FIXTURE_AGENT_A}`, `shared:${ws}`],
  );
  assert.deepEqual(
    resolveReadScopes({ workspaceId: ws, agentId: FIXTURE_AGENT_A, taskId: 'run-9', kind: 'run' }),
    [`run:${ws}:run-9`, `agent:${ws}:${FIXTURE_AGENT_A}`, `shared:${ws}`],
  );
  assert.deepEqual(
    resolveReadScopes({ workspaceId: ws, agentId: FIXTURE_AGENT_A, automationId: 'auto-1', kind: 'automation' }),
    [`automation:${ws}:auto-1`, `agent:${ws}:${FIXTURE_AGENT_A}`, `shared:${ws}`],
  );
  assert.deepEqual(
    resolveReadScopes({ workspaceId: ws, fromAgentId: FIXTURE_AGENT_A, toAgentId: FIXTURE_AGENT_B, taskId: 'run-1', kind: 'delegation' }),
    [`delegation:${ws}:${FIXTURE_AGENT_A}:${FIXTURE_AGENT_B}`, `agent:${ws}:${FIXTURE_AGENT_B}`, `run:${ws}:run-1`, `shared:${ws}`],
  );
});

test('archive-scope matrix: where records land', () => {
  const ws = FIXTURE_WS;
  assert.equal(resolveArchiveScope({ workspaceId: ws, issueId: 'i1', kind: 'task' }), `task:${ws}:i1`);
  assert.equal(
    resolveArchiveScope({ workspaceId: ws, agentId: 'a1', userId: 'u1', kind: 'chat' }),
    `dm:${ws}:a1:u1`,
  );
  assert.equal(resolveArchiveScope({ workspaceId: ws, taskId: 't1', kind: 'run' }), `run:${ws}:t1`);
  assert.equal(resolveArchiveScope({ workspaceId: ws, automationId: 'au1', kind: 'automation' }), `automation:${ws}:au1`);
  assert.equal(
    resolveArchiveScope({ workspaceId: ws, fromAgentId: 'a1', toAgentId: 'a2', kind: 'delegation' }),
    `delegation:${ws}:a1:a2`,
  );
});

test('scopeKey validates inputs', () => {
  assert.throws(() => scopeKey('bogus', 'x'));
  assert.throws(() => scopeKey('task', ''));
  assert.throws(() => scopeKey('task', null));
});

test('OV ids are deterministic', () => {
  assert.equal(accountIdFor(FIXTURE_WS), accountIdFor(FIXTURE_WS));
  assert.notEqual(accountIdFor(FIXTURE_WS), accountIdFor('other'));
  assert.equal(userIdFor(`task:${FIXTURE_WS}:i1`), userIdFor(`task:${FIXTURE_WS}:i1`));
});

test('registry provisions lazily against OV and persists keys', async () => {
  const ov = await startFakeOv();
  try {
    const client = new OvClient({ baseUrl: ov.baseUrl });
    const stateDir = tempStateDir();
    const reg1 = new ScopeRegistry({ ov: client, rootKey: 'root', stateDir, log: () => {} });
    const sk = scopeKey('task', FIXTURE_WS, FIXTURE_ISSUE_ID);
    const rec = await reg1.ensureScope(sk, { workspaceId: FIXTURE_WS });
    assert.ok(rec.apiKey.startsWith('ovusr-'));
    assert.equal(ov.accounts.size, 1);
    assert.equal([...ov.accounts.values()][0].users.size, 1);

    // Second registry instance (simulated restart) reuses persisted keys, no re-provision.
    const reg2 = new ScopeRegistry({ ov: client, rootKey: 'root', stateDir, log: () => {} });
    assert.equal(reg2.get(sk)?.apiKey, rec.apiKey);
    assert.equal(ov.accounts.size, 1);
    assert.equal([...ov.accounts.values()][0].users.size, 1);

    // Key-loss recovery: wipe the stored key, ensureScope regenerates via admin API.
    delete reg2.data.scopes[sk].apiKey;
    const rec3 = await reg2.ensureScope(sk, { workspaceId: FIXTURE_WS });
    assert.ok(rec3.apiKey.startsWith('ovusr-'));
    assert.notEqual(rec3.apiKey, rec.apiKey);
  } finally {
    await ov.stop();
  }
});

test('runScopes: a run archives where its kind says, and reads only its own scopes', () => {
  const ws = FIXTURE_WS;
  const issueRun = runScopes({ workspaceId: ws, task: fixtureTask({ taskId: 't1' }) });
  assert.equal(issueRun.archiveScope, scopeKey('task', ws, FIXTURE_ISSUE_ID));
  assert.deepEqual(issueRun.readScopes, [
    scopeKey('task', ws, FIXTURE_ISSUE_ID), scopeKey('agent', ws, FIXTURE_AGENT_A), scopeKey('shared', ws),
  ]);
  assert.equal(issueRun.delegationScope, null);

  const chatRun = runScopes({ workspaceId: ws, task: fixtureTask({ taskId: 't2', kind: 'chat', chat_session_id: 'cs-1', chat_user_id: FIXTURE_USER }) });
  assert.equal(chatRun.archiveScope, scopeKey('dm', ws, FIXTURE_AGENT_A, FIXTURE_USER));
  assert.equal(chatRun.readScopes.some((s) => s.startsWith('task:')), false, 'a DM run reads no task memory');

  const autopilotRun = runScopes({ workspaceId: ws, task: fixtureTask({ taskId: 't3', kind: 'autopilot', autopilot_id: 'ap-1' }) });
  assert.equal(autopilotRun.archiveScope, scopeKey('automation', ws, 'ap-1'));

  const quick = runScopes({ workspaceId: ws, task: fixtureTask({ taskId: 't4', kind: 'quick_create' }) });
  assert.equal(quick.archiveScope, scopeKey('run', ws, 't4'));

  const delegated = runScopes({ workspaceId: ws, task: fixtureTask({ taskId: 't5', agentId: FIXTURE_AGENT_B, delegated_from_agent_id: FIXTURE_AGENT_A }) });
  assert.equal(delegated.delegationScope, scopeKey('delegation', ws, FIXTURE_AGENT_A, FIXTURE_AGENT_B));
  assert.ok(delegated.readScopes.includes(delegated.delegationScope));
  const selfDelegated = runScopes({ workspaceId: ws, task: fixtureTask({ taskId: 't6', delegated_from_agent_id: FIXTURE_AGENT_A }) });
  assert.equal(selfDelegated.delegationScope, null, 'an agent does not open a channel with itself');
});

test('runScopes refuses a run that lacks the link its kind needs', () => {
  const ws = FIXTURE_WS;
  assert.equal(runScopes({ workspaceId: ws, task: fixtureTask({ taskId: 'x', issueId: null }) }), null);
  assert.equal(runScopes({ workspaceId: ws, task: fixtureTask({ taskId: 'x', kind: 'chat' }) }), null);
  assert.equal(runScopes({ workspaceId: ws, task: fixtureTask({ taskId: 'x', kind: 'autopilot' }) }), null);
  assert.equal(runScopes({ workspaceId: ws, task: { id: 'x', kind: 'issue', issue_id: FIXTURE_ISSUE_ID } }), null, 'no agent');
  assert.equal(runScopes({ workspaceId: null, task: fixtureTask({ taskId: 'x' }) }), null);
});
