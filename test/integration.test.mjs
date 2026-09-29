import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadConfig, mergeCallConfig } from '../src/config.mjs';
import { OvClient } from '../src/ov-client.mjs';
import { ScopeRegistry, scopeKey } from '../src/scopes.mjs';
import { JobQueue } from '../src/queue.mjs';
import { makeArchiveHandler } from '../src/pipeline.mjs';
import { Ledger, ArchiveStatusLog } from '../src/ledger.mjs';
import { createApp, buildRequestListener } from '../src/server.mjs';
import {
  startFakeOv, startFakeMultica, makeSigningSecret, signDelivery, postJson,
  fixtureIssue, fixtureTranscript, hookBody,
  FIXTURE_WS, FIXTURE_ISSUE_ID, FIXTURE_AGENT_A, FIXTURE_AGENT_B,
} from './helpers.mjs';
import { sleep } from '../src/util.mjs';

const TASK_ID = 'task-run-1001';

async function bootAll({ ov, multica, stateDir }) {
  const cfg = {
    ...loadConfig({}, { stateDir }),
    ovBaseUrl: ov.baseUrl,
    ovRootKey: 'root',
    signingSecret: SECRET,
    pluginToken: 'test-admin-token',
    callbackTimeoutMs: 3000,
    extractWatchTimeoutMs: 4000,
    extractWatchIntervalMs: 40,
    reextractAttempts: 2,
    reextractBaseDelayMs: 30,
    includeThinking: false,
    dropToolPrefixes: ['multica issue list'],
    recallEntries: 5,
    recallPerScopeLimit: 10,
    recallContentMaxChars: 2400,
  };
  const ovClient = new OvClient({ baseUrl: ov.baseUrl, timeoutMs: 3000 });
  const registry = new ScopeRegistry({ ov: ovClient, rootKey: 'root', stateDir, log: () => {} });
  const ledger = new Ledger({ stateDir });
  const statusLog = new ArchiveStatusLog({ stateDir });
  const queue = new JobQueue({
    stateDir,
    handler: makeArchiveHandler({ ov: ovClient, registry, statusLog, cfg, log: () => {} }),
    maxAttempts: 3, baseDelayMs: 5, pollMs: 10, log: () => {},
  });
  queue.start();
  const app = createApp({ cfg, ov: ovClient, registry, queue, ledger, statusLog });
  const handler = await buildRequestListener({ cfg, app });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { app, server, port: server.address().port, queue, cfg, registry, statusLog, ovClient };
}

const SECRET = makeSigningSecret();

async function signedPost(port, path, body, { secret = SECRET, ts } = {}) {
  const raw = JSON.stringify(body);
  const { timestamp, signature } = signDelivery({ secret, body: raw, timestamp: ts });
  return postJson(port, path, raw, { headers: {
    'Content-Type': 'application/json',
    'X-Multica-Timestamp': timestamp,
    'X-Multica-Signature': signature,
    'X-Multica-Plugin-Installation': 'inst-1',
  } });
}

test('integration: task.completed → archive → extract → recall → isolation → dedupe', async () => {
  const ov = await startFakeOv();
  const multica = await startFakeMultica({
    issue: fixtureIssue(),
    transcript: fixtureTranscript({ taskId: TASK_ID }),
  });
  let harness;
  try {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const stateDir = mkdtempSync(join(tmpdir(), 'ovmem-it-'));
    harness = await bootAll({ ov, multica, stateDir });
    const { port, registry, statusLog } = harness;

    // ---- 1. signed event delivery is accepted fast and queued
    const res = await signedPost(port, '/hooks/memory-archive', hookBody({
      eventType: 'task.completed',
      invocationId: 'inv-dedupe-1',
      input: { task_id: TASK_ID, agent_id: FIXTURE_AGENT_A, issue_id: FIXTURE_ISSUE_ID, status: 'completed' },
      callbackUrl: multica.baseUrl + '/v1',
    }));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.result.status, 'queued');
    assert.equal(res.json.result.completeness, 'complete');

    // ---- 2. unsigned / badly signed deliveries rejected
    const bad = await postJson(port, '/hooks/memory-archive', hookBody({
      eventType: 'task.completed',
      input: { task_id: 'x', agent_id: 'y', issue_id: 'z' },
      callbackUrl: multica.baseUrl + '/v1',
    }));
    assert.equal(bad.status, 401);

    // ---- 3. queue archives into the task scope with proper structure
    await sleep(400);
    const taskScope = scopeKey('task', FIXTURE_WS, FIXTURE_ISSUE_ID);
    const rec = registry.get(taskScope);
    assert.ok(rec, 'task scope provisioned');
    const session = ov.sessionsOf(rec.apiKey).get(`mc-task-${TASK_ID}`);
    assert.ok(session, 'run session created');
    assert.equal(session.committed, true);
    assert.ok(session.tags.includes('scope=task'));
    // user_query + business content present; probe tool dropped; runtime brief stripped
    const userMsg = session.messages[0];
    assert.equal(userMsg.message_kind, 'user_query');
    assert.match(userMsg.content, /MUL-7/);
    assert.match(userMsg.content, /对比 Kafka 与 RocketMQ/);
    const flat = JSON.stringify(session.messages);
    assert.equal(flat.includes('issue list'), false);
    assert.equal(flat.includes('Multica Agent Runtime'), false);
    assert.equal(flat.includes('推荐 RocketMQ'), true);

    // ---- 4. redelivery of the same invocation is a ledger duplicate
    const again = await signedPost(port, '/hooks/memory-archive', hookBody({
      eventType: 'task.completed',
      invocationId: 'inv-dedupe-1',
      input: { task_id: TASK_ID, agent_id: FIXTURE_AGENT_A, issue_id: FIXTURE_ISSUE_ID, status: 'completed' },
      callbackUrl: multica.baseUrl + '/v1',
    }));
    assert.equal(again.json.result.status, 'duplicate');
    await sleep(150);
    assert.equal(ov.sessionsOf(rec.apiKey).size, 1, 'no duplicate session');

    // ---- 5. agent recall tool: signed agent trigger, scoped read
    const recallBody = {
      version: 1, invocation_id: 'inv-agent-1', attempt: 1,
      occurred_at: new Date().toISOString(), hook_key: 'memory-recall',
      trigger: 'agent', workspace_id: FIXTURE_WS, installation_id: 'inst-1',
      actor: { type: 'agent', id: FIXTURE_AGENT_A },
      input: { query: '选型' },
      config: {},
    };
    const rr = await signedPost(port, '/hooks/memory-recall', recallBody);
    assert.equal(rr.status, 200, rr.text);
    // fake OV spaces are empty until written; scopesSearched shows provisioning state
    assert.equal(rr.json.result.entries instanceof Array, true);

    // ---- 6. agent remember tool writes into THIS agent's public space only
    const remBody = {
      ...recallBody, hook_key: 'memory-remember', invocation_id: 'inv-agent-2',
      input: { content: '顺序性消息场景选 RocketMQ,事务消息原生支持。', title: '消息选型结论', kind: 'cases' },
    };
    const rem = await signedPost(port, '/hooks/memory-remember', remBody);
    assert.equal(rem.status, 200, rem.text);
    const agentScope = scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_A);
    const agentRec = registry.get(agentScope);
    assert.ok(agentRec);
    const files = ov.filesOf(agentRec.apiKey);
    assert.equal(files.size, 1);
    const [[uri, content]] = [...files];
    assert.match(uri, /^viking:\/\/user\/[^/]+\/memories\/cases\//);
    assert.match(content, /RocketMQ/);
    assert.match(rem.json.result.uri, /^viking:\/\/user\/[^/]+\/memories\/cases\//);
    // agent B's space stays empty
    const scopeB = scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_B);
    assert.equal(registry.get(scopeB), null);

    // ---- 7. recall now finds the remembered knowledge for agent A
    const rr2 = await signedPost(port, '/hooks/memory-recall', { ...recallBody, invocation_id: 'inv-agent-3' });
    assert.equal(rr2.status, 200);
    assert.ok(rr2.json.result.entries.some((e) => e.scope === agentScope), 'agent-A recall hits own public memory');

    // ---- 8. status tool
    const st = await signedPost(port, '/hooks/memory-status', {
      ...recallBody, hook_key: 'memory-status', invocation_id: 'inv-agent-4', input: {},
    });
    assert.equal(st.status, 200);
    assert.equal(st.json.result.openviking.healthy, true);
    assert.equal(st.json.result.archive_queue.done >= 1, true);
    assert.ok(st.json.result.recent_archives.length >= 1);

    // ---- 9. comment.created archives with attribution
    const cres = await signedPost(port, '/hooks/memory-archive', hookBody({
      eventType: 'comment.created',
      input: {
        comment: { id: 'cm-1', issue_id: FIXTURE_ISSUE_ID, content: '死信队列补充对比', author: { id: 'member-7', name: 'cloud' }, created_at: new Date().toISOString() },
        issue_title: '为消息推送服务选型', issue_assignee_type: 'agent', issue_assignee_id: FIXTURE_AGENT_A, issue_status: 'open',
      },
      callbackUrl: multica.baseUrl + '/v1',
    }));
    assert.equal(cres.json.result.status, 'queued');
    await sleep(300);
    const csession = ov.sessionsOf(rec.apiKey).get('mc-comment-cm-1');
    assert.ok(csession, 'comment session in task scope');
    assert.equal(csession.messages[0].peer_id, 'member-7');

    // ---- 10. admin status requires the bearer token
    const noAuth = await postJson(port, '/admin/status', {});
    assert.equal(noAuth.status, 401);
    const admin = await postJson(port, '/admin/status', {}, { headers: { Authorization: 'Bearer test-admin-token' } });
    assert.equal(admin.status, 200);
    assert.equal(admin.json.result.scopes.scopes >= 2, true);

    // ---- 11. isolation: task-scope key cannot read another space's content
    const other = await fetch(`${ov.baseUrl}/api/v1/content/read?uri=${encodeURIComponent('memories/cases/x.md')}`, {
      headers: { Authorization: `Bearer ${rec.apiKey}` },
    });
    assert.equal(other.status, 404);
  } finally {
    if (harness) {
      await harness.queue.stop({ drainMs: 500 }).catch(() => {});
      await new Promise((r) => harness.server.close(r));
    }
    await multica.stop();
    await ov.stop();
  }
});

test('integration: extraction failure triggers auto re-extract recovery', async () => {
  const ov = await startFakeOv({ taskBehavior: 'fail-once' });
  const multica = await startFakeMultica({
    issue: fixtureIssue(),
    transcript: fixtureTranscript({ taskId: 'task-run-2002' }),
  });
  let harness;
  try {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const stateDir = mkdtempSync(join(tmpdir(), 'ovmem-it2-'));
    harness = await bootAll({ ov, multica, stateDir });
    const res = await signedPost(harness.port, '/hooks/memory-archive', hookBody({
      eventType: 'task.completed',
      input: { task_id: 'task-run-2002', agent_id: FIXTURE_AGENT_A, issue_id: FIXTURE_ISSUE_ID },
      callbackUrl: multica.baseUrl + '/v1',
    }));
    assert.equal(res.json.result.status, 'queued');
    // fake OV: task fails once (429) → plugin re-extracts → fake marks succeeded
    await sleep(2000);
    const taskScope = scopeKey('task', FIXTURE_WS, FIXTURE_ISSUE_ID);
    const rec = harness.registry.get(taskScope);
    const space = ov.spaces.get(rec.apiKey);
    assert.equal(space.extracts.length >= 1, true, 're-extract was attempted');
    const recent = harness.statusLog.recent({ limit: 5 }).find((e) => e.type === 'archive-run');
    assert.ok(recent);
    assert.equal(recent.extraction, 'reextracted');
  } finally {
    if (harness) {
      await harness.queue.stop({ drainMs: 500 }).catch(() => {});
      await new Promise((r) => harness.server.close(r));
    }
    await multica.stop();
    await ov.stop();
  }
});
