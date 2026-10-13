import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeKey } from '../src/scopes.mjs';
import {
  startFakeOv, startFakeMultica, fixtureIssue, fixtureTask, hookBody, commentEvent, taskEvent, makeSigningSecret, tempStateDir,
  FIXTURE_WS, FIXTURE_ISSUE_ID, FIXTURE_AGENT_A, FIXTURE_AGENT_B, FIXTURE_USER,
} from './helpers.mjs';
import { bootService, waitFor } from './harness.mjs';

// Background reads beyond the happy path: a restart with reads still queued,
// a rotated token and the operator's redrive, stock multica, failed runs and
// the other kinds of run.

const TOKEN = `mpi_${'b'.repeat(32)}`;
const taskScope = scopeKey('task', FIXTURE_WS, FIXTURE_ISSUE_ID);
const steps = (taskId, n, last = '结论：灰度先双写两周。') => [
  ...Array.from({ length: n }, (_, i) => ({ task_id: taskId, seq: i + 1, type: 'text', content: `第 ${i} 步：检查分片 ${i}。` })),
  { task_id: taskId, seq: n + 1, type: 'text', content: last },
];

async function stack({ tasks, transcript, taskApi = true }) {
  const ov = await startFakeOv();
  const multica = await startFakeMultica({ issue: fixtureIssue(), tasks, transcript, taskApi });
  const cfg = { multicaApiUrl: `${multica.baseUrl}/v1`, multicaToken: TOKEN };
  return { ov, multica, cfg, cb: `${multica.baseUrl}/v1` };
}

const archived = (ov, svc, scope, sessionId, label = sessionId) => waitFor(() => {
  const rec = svc.registry.get(scope);
  const msgs = rec ? ov.archivedOf(rec.apiKey, sessionId) : [];
  return msgs.length ? msgs : null;
}, { label, timeoutMs: 8000 });

test('a run registered before a restart is read by the restarted service', async () => {
  const taskId = 'run-restart';
  const { ov, multica, cfg, cb } = await stack({ tasks: { [taskId]: fixtureTask({ taskId }) }, transcript: steps(taskId, 30) });
  const stateDir = tempStateDir();
  const secret = makeSigningSecret();
  let svc = await bootService({ ov, stateDir, secret, cfg });
  try {
    // The hook registers the run; the service stops before its queue reads it.
    await svc.queue.stop({ drainMs: 0 });
    const r = await svc.signedPost('/hooks/memory-archive', hookBody({ eventType: 'task.completed', input: taskEvent({ taskId }), callbackUrl: cb }));
    assert.equal(r.json.result.fetch, 'background');
    // (The workspace's provisioning finishes first: both services share this
    // process, and a stopped one would otherwise keep writing its state.)
    await svc.memoryRules.settled(FIXTURE_WS);
    await svc.stop();

    svc = await bootService({ ov, stateDir, secret, cfg });
    const msgs = await archived(ov, svc, taskScope, `mc-task-${taskId}`);
    assert.match(JSON.stringify(msgs), /结论：灰度先双写两周/);
    const job = svc.queue.findByDedupeKey(`fetch-run:${FIXTURE_WS}:${taskId}`);
    assert.equal(job.status, 'done');
    assert.equal(job.attempts, 0, 'read by its own route on the first try');
  } finally {
    await svc.stop();
    await multica.stop();
    await ov.stop();
  }
});

test('after a rotated token is replaced, /admin/redrive reads the run that failed', async () => {
  const taskId = 'run-rotated';
  const { ov, multica, cfg, cb } = await stack({ tasks: { [taskId]: fixtureTask({ taskId }) }, transcript: steps(taskId, 5) });
  multica.setRejectInstallToken(true);
  const svc = await bootService({ ov, cfg });
  try {
    await svc.signedPost('/hooks/memory-archive', hookBody({ eventType: 'task.completed', input: taskEvent({ taskId }), callbackUrl: cb }));
    const job = await waitFor(() => {
      const j = svc.queue.findByDedupeKey(`fetch-run:${FIXTURE_WS}:${taskId}`);
      return j?.status === 'failed' ? j : null;
    }, { label: 'failed fetch' });
    const hint = job.last_error.match(/POST \/admin\/redrive (\{.*\})/);
    assert.ok(hint, job.last_error);

    // The operator updates the token; the documented redrive reads the run.
    multica.setRejectInstallToken(false);
    const res = await svc.admin('/admin/redrive', JSON.parse(hint[1]));
    assert.equal(res.status, 200, res.text);
    const msgs = await archived(ov, svc, taskScope, `mc-task-${taskId}`, 'run archive after redrive');
    assert.match(JSON.stringify(msgs), /结论：灰度先双写两周/);
  } finally {
    await svc.stop();
    await multica.stop();
    await ov.stop();
  }
});

test('stock multica with a token: the run is skipped, and its closing comment is archived as the run\'s record', async () => {
  const taskId = 'run-stock';
  const { ov, multica, cfg, cb } = await stack({ tasks: {}, transcript: [], taskApi: false });
  const svc = await bootService({ ov, cfg });
  try {
    const closing = commentEvent({ id: 'cm-stock', content: '结论：推荐 RocketMQ，预算 ¥3800/月。', authorType: 'agent', authorId: FIXTURE_AGENT_A, sourceTaskId: taskId });
    await svc.signedPost('/hooks/memory-archive', hookBody({ eventType: 'comment.created', input: closing, callbackUrl: cb }));
    const r = await svc.signedPost('/hooks/memory-archive', hookBody({ eventType: 'task.completed', input: taskEvent({ taskId }), callbackUrl: cb }));
    assert.equal(r.status, 200);
    await waitFor(() => svc.statusLog.recent({ limit: 30 }).find((e) => e.type === 'skipped' && e.ref === taskId), { label: 'run skipped' });
    const msgs = await archived(ov, svc, taskScope, 'mc-comment-cm-stock', 'closing comment archive');
    assert.match(JSON.stringify(msgs), /RocketMQ/);
    assert.equal(svc.queue.findByDedupeKey(`archive-run:${FIXTURE_WS}:${taskId}`), null);
    assert.equal(svc.queue.findByDedupeKey(`fetch-run:${FIXTURE_WS}:${taskId}`).attempts, 0, 'a skip, not a failure');
  } finally {
    await svc.stop();
    await multica.stop();
    await ov.stop();
  }
});

test('a failed run is read in the background and archived with its failure', async () => {
  const taskId = 'run-failed';
  const task = fixtureTask({ taskId, status: 'failed', failure_reason: 'agent_error' });
  const { ov, multica, cfg, cb } = await stack({ tasks: { [taskId]: task }, transcript: steps(taskId, 3, '执行失败：kubectl 无权限访问 orders 命名空间。') });
  const svc = await bootService({ ov, cfg });
  try {
    const r = await svc.signedPost('/hooks/memory-archive', hookBody({ eventType: 'task.failed', input: taskEvent({ taskId, status: 'failed' }), callbackUrl: cb }));
    assert.equal(r.json.result.fetch, 'background', r.text);
    const msgs = await archived(ov, svc, taskScope, `mc-task-${taskId}`);
    const text = JSON.stringify(msgs);
    assert.match(text, /kubectl 无权限/);
    assert.match(text, /最终状态: failed/);
  } finally {
    await svc.stop();
    await multica.stop();
    await ov.stop();
  }
});

test('chat, autopilot and delegated runs read in the background land in their own scopes', async () => {
  const tasks = {
    'bg-chat': fixtureTask({ taskId: 'bg-chat', kind: 'chat', chat_session_id: 'cs-bg', chat_user_id: FIXTURE_USER,
      input: [{ source: 'chat_message', author_type: 'member', author_id: FIXTURE_USER, content: '记住：接口命名一律用驼峰。' }] }),
    'bg-auto': fixtureTask({ taskId: 'bg-auto', kind: 'autopilot', autopilot_id: 'ap-bg', trigger_summary: 'nightly triage' }),
    'bg-deleg': fixtureTask({ taskId: 'bg-deleg', agentId: FIXTURE_AGENT_B, delegated_from_agent_id: FIXTURE_AGENT_A,
      input: [{ source: 'comment', author_type: 'agent', author_id: FIXTURE_AGENT_A, content: '[@复核](mention://agent/b) 重试上限为 7 次，请复核。' }] }),
  };
  const transcript = Object.keys(tasks).flatMap((id) => steps(id, 2, `done ${id}`));
  const { ov, multica, cfg, cb } = await stack({ tasks, transcript });
  const svc = await bootService({ ov, cfg });
  try {
    for (const id of Object.keys(tasks)) {
      const r = await svc.signedPost('/hooks/memory-archive', hookBody({ eventType: 'task.completed',
        input: taskEvent({ taskId: id, agentId: tasks[id].agent_id, issueId: tasks[id].issue_id ?? '' }), callbackUrl: cb }));
      assert.equal(r.json.result.fetch, 'background', `${id}: ${r.text}`);
    }
    const dm = await archived(ov, svc, scopeKey('dm', FIXTURE_WS, FIXTURE_AGENT_A, FIXTURE_USER), 'mc-task-bg-chat');
    assert.equal(dm.find((m) => /接口命名一律用驼峰/.test(m.content ?? ''))?.peer_id, FIXTURE_USER);
    await archived(ov, svc, scopeKey('automation', FIXTURE_WS, 'ap-bg'), 'mc-task-bg-auto');
    await archived(ov, svc, taskScope, 'mc-task-bg-deleg');
    const handoff = await archived(ov, svc, scopeKey('delegation', FIXTURE_WS, FIXTURE_AGENT_A, FIXTURE_AGENT_B), 'mc-deleg-bg-deleg');
    assert.match(JSON.stringify(handoff), /重试上限为 7 次/);
    // Every read used the install token.
    assert.ok(multica.requests.filter((q) => q.path.startsWith('/v1/tasks/')).every((q) => q.token.startsWith('Bearer mpi_')));
  } finally {
    await svc.stop();
    await multica.stop();
    await ov.stop();
  }
});
