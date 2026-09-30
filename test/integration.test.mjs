import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeKey } from '../src/scopes.mjs';
import {
  startFakeOv, startFakeMultica, fixtureIssue, fixtureTranscript, fixtureTask, hookBody, commentEvent, taskEvent,
  FIXTURE_WS, FIXTURE_ISSUE_ID, FIXTURE_AGENT_A, FIXTURE_AGENT_B, FIXTURE_USER,
} from './helpers.mjs';
import { bootService, waitFor } from './harness.mjs';

// Archiving paths end to end over realistic doubles. "Stock" multica is v0.6 as
// released (no task read API); "patched" carries GET /v1/tasks/{id}[/messages].

async function withStack({ taskApi = false, tasks = {}, transcript = [], ovOpts = {}, cfg = {} } = {}, fn) {
  const ov = await startFakeOv(ovOpts);
  const multica = await startFakeMultica({ issue: fixtureIssue(), tasks, transcript, taskApi });
  const svc = await bootService({ ov, cfg });
  try {
    await fn({ ov, multica, svc, cb: multica.baseUrl + '/v1' });
  } finally {
    await svc.stop();
    await multica.stop();
    await ov.stop();
  }
}

const archiveBody = (cb, eventType, input, extra) => hookBody({ eventType, input, callbackUrl: cb, extra });
const taskScope = scopeKey('task', FIXTURE_WS, FIXTURE_ISSUE_ID);
const archivedText = (ov, rec, sid) => JSON.stringify(ov.archivedOf(rec.apiKey, sid));

test('stock multica: a task event it cannot describe is skipped with 200 — never a 5xx that trips the breaker', async () => {
  await withStack({}, async ({ svc, cb }) => {
    // issue run: no transcript API → nothing but metadata → skipped, not archived as noise
    const issueRun = await svc.signedPost('/hooks/memory-archive', archiveBody(cb, 'task.completed', taskEvent({ taskId: 'run-1' })));
    assert.equal(issueRun.status, 200, issueRun.text);
    assert.equal(issueRun.json.result.status, 'skipped');
    assert.match(issueRun.json.result.reason, /nothing to archive/);

    // chat run: multica publishes issue_id "" — the event that used to 500 three times per chat turn
    const chat = await svc.signedPost('/hooks/memory-archive', archiveBody(cb, 'task.completed', taskEvent({ taskId: 'chat-1', issueId: '', chatSessionId: 'cs-1' })));
    assert.equal(chat.status, 200);
    assert.equal(chat.json.result.status, 'skipped');
    assert.match(chat.json.result.reason, /no task API/);

    // intermediate failure of a run multica will retry
    const retrying = await svc.signedPost('/hooks/memory-archive', archiveBody(cb, 'task.failed', taskEvent({ taskId: 'run-2', status: 'failed', retry_pending: true, failure_reason: 'agent_error' })));
    assert.equal(retrying.json.result.status, 'skipped');
    assert.match(retrying.json.result.reason, /retrying/);

    // an unsubscribed or unknown event is also a 200 skip
    const other = await svc.signedPost('/hooks/memory-archive', archiveBody(cb, 'issue.updated', {}));
    assert.equal(other.status, 200);
    assert.equal(other.json.result.status, 'skipped');
    assert.equal(svc.queue.stats().queued + svc.queue.stats().done, 0, 'nothing was queued');
  });
});

test('comments are archived with honest attribution: member = human feedback, agent = agent statement, system skipped', async () => {
  await withStack({}, async ({ ov, svc, cb }) => {
    const member = commentEvent({ id: 'cm-member', content: '死信队列的监控告警要求补充进方案,峰值堆积阈值 1 万条。' });
    const agent = commentEvent({ id: 'cm-agent', content: '最终结论:推荐 RocketMQ。', authorType: 'agent', authorId: FIXTURE_AGENT_A, sourceTaskId: 'run-9' });
    const system = commentEvent({ id: 'cm-system', content: 'runtime unusable', authorType: 'system', authorId: '' });
    for (const input of [member, agent, system]) {
      const r = await svc.signedPost('/hooks/memory-archive', archiveBody(cb, 'comment.created', input));
      assert.equal(r.status, 200, r.text);
    }
    const rec = await waitFor(() => svc.registry.get(taskScope), { label: 'task scope' });
    await waitFor(() => ov.archivedOf(rec.apiKey, 'mc-comment-cm-member').length && ov.archivedOf(rec.apiKey, 'mc-comment-cm-agent').length, { label: 'comment archives' });

    const [human] = ov.archivedOf(rec.apiKey, 'mc-comment-cm-member');
    assert.equal(human.role, 'user');
    assert.equal(human.peer_id, FIXTURE_USER);
    assert.match(human.content, /\[人类反馈\]\[评论\] MUL-7/);

    const agentMsgs = ov.archivedOf(rec.apiKey, 'mc-comment-cm-agent');
    const statement = agentMsgs.find((m) => m.role === 'assistant');
    assert.ok(statement, 'agent comment archived as assistant output');
    assert.match(statement.parts[0].text, /\[智能体评论\] 智能体 33333333/);
    assert.equal(JSON.stringify(agentMsgs).includes('人类反馈'), false, 'an agent is never recorded as human feedback');

    assert.equal(ov.sessionsOf(rec.apiKey).has('mc-comment-cm-system'), false, 'system notices are not archived');
    const skipped = svc.statusLog.recent({ limit: 20 }).find((e) => e.type === 'skipped' && e.ref === 'cm-system');
    assert.ok(skipped, 'the skip is visible in the status log');
  });
});

test('patched multica: a run\'s closing comment that arrives before its task event is not archived twice', async () => {
  const taskId = 'run-closing';
  await withStack({ taskApi: true, tasks: { [taskId]: fixtureTask({ taskId }) }, transcript: fixtureTranscript({ taskId }) }, async ({ svc, cb, multica }) => {
    // Fresh service: nothing has told it yet whether this multica has the task API.
    const closing = await svc.signedPost('/hooks/memory-archive', archiveBody(cb, 'comment.created',
      commentEvent({ id: 'cm-closing', content: '最终结论:推荐 RocketMQ。', authorType: 'agent', authorId: FIXTURE_AGENT_A, sourceTaskId: taskId })));
    assert.equal(closing.json.result.status, 'skipped', closing.text);
    assert.match(closing.json.result.reason, /covered by its run archive/);
    assert.ok(multica.requests.some((r) => r.path === `/v1/tasks/${taskId}`), 'asked multica once');

    const run = await svc.signedPost('/hooks/memory-archive', archiveBody(cb, 'task.completed', taskEvent({ taskId })));
    assert.equal(run.json.result.status, 'queued', 'the run itself is archived');
  });
});

test('patched multica: issue run archives the real transcript with the installation\'s own archive settings', async () => {
  const taskId = 'run-issue-1';
  await withStack({
    taskApi: true,
    tasks: { [taskId]: fixtureTask({ taskId, input: [{ source: 'comment', author_type: 'member', author_id: FIXTURE_USER, content: '请比较 Kafka 与 RocketMQ' }] }) },
    transcript: fixtureTranscript({ taskId }),
    cfg: { dropToolPrefixes: [] }, // service default drops nothing …
  }, async ({ ov, svc, cb }) => {
    const body = archiveBody(cb, 'task.completed', taskEvent({ taskId }));
    body.config = { drop_tool_prefixes: 'multica issue list', include_thinking: false }; // … the installation's config does
    const r = await svc.signedPost('/hooks/memory-archive', body);
    assert.equal(r.json.result.status, 'queued', r.text);
    assert.equal(r.json.result.kind, 'issue');
    assert.equal(r.json.result.completeness, 'complete');

    const rec = await waitFor(() => svc.registry.get(taskScope), { label: 'task scope' });
    await waitFor(() => ov.archivedOf(rec.apiKey, `mc-task-${taskId}`).length, { label: 'run archive' });
    const flat = archivedText(ov, rec, `mc-task-${taskId}`);
    assert.match(flat, /MUL-7/);
    assert.match(flat, /推荐 RocketMQ/, 'the agent\'s conclusion is archived');
    assert.match(flat, /触发评论/, 'the member input that started the run is archived');
    assert.equal(flat.includes('issue list'), false, 'probe dropped by the installation\'s drop_tool_prefixes');
    assert.equal(flat.includes('Multica Agent Runtime'), false, 'runtime brief stripped');
    assert.equal(flat.includes('internal reasoning'), false, 'thinking excluded');

    // once multica has shown it hands transcripts over, the agent's own comment
    // from that run is covered by the run archive
    const again = await svc.signedPost('/hooks/memory-archive', archiveBody(cb, 'comment.created',
      commentEvent({ id: 'cm-dup', content: '最终结论:推荐 RocketMQ。', authorType: 'agent', authorId: FIXTURE_AGENT_A, sourceTaskId: taskId })));
    assert.equal(again.json.result.status, 'skipped');
    assert.match(again.json.result.reason, /covered by its run archive/);
  });
});

test('multica\'s retry of a delivery (a new invocation id) is a duplicate, archived once', async () => {
  const taskId = 'run-retried';
  await withStack({ taskApi: true, tasks: { [taskId]: fixtureTask({ taskId }) }, transcript: fixtureTranscript({ taskId }) }, async ({ ov, svc, cb }) => {
    const first = await svc.signedPost('/hooks/memory-archive', archiveBody(cb, 'task.completed', taskEvent({ taskId })));
    assert.equal(first.json.result.status, 'queued', first.text);
    const retry = await svc.signedPost('/hooks/memory-archive', archiveBody(cb, 'task.completed', taskEvent({ taskId })));
    assert.equal(retry.json.result.status, 'duplicate', retry.text);
    assert.equal(retry.json.result.job, first.json.result.job);

    const comment = commentEvent({ id: 'cm-retried', content: '补充:需要回滚预案。' });
    await svc.signedPost('/hooks/memory-archive', archiveBody(cb, 'comment.created', comment));
    const commentRetry = await svc.signedPost('/hooks/memory-archive', archiveBody(cb, 'comment.created', comment));
    assert.equal(commentRetry.json.result.status, 'duplicate');

    const rec = await waitFor(() => svc.registry.get(taskScope), { label: 'task scope' });
    await waitFor(() => svc.queue.stats().done === 2, { label: 'both records settled' });
    assert.equal(svc.queue.jobs.size, 2);
    assert.equal(ov.sessionsOf(rec.apiKey).get(`mc-task-${taskId}`).commitCount, 1, 'committed once');
  });
});

test('patched multica: chat, autopilot, quick-create and delegated runs land in their own scopes', async () => {
  const tasks = {
    'run-chat': fixtureTask({ taskId: 'run-chat', kind: 'chat', chat_session_id: 'cs-9', chat_user_id: FIXTURE_USER,
      input: [{ source: 'chat_message', author_type: 'member', author_id: FIXTURE_USER, content: '记住:代码注释一律用中文。' }] }),
    'run-auto': fixtureTask({ taskId: 'run-auto', kind: 'autopilot', autopilot_id: 'ap-1', trigger_summary: 'nightly triage' }),
    'run-quick': fixtureTask({ taskId: 'run-quick', kind: 'quick_create', input: [{ source: 'quick_create', author_type: 'member', author_id: FIXTURE_USER, content: '建一个修复登录超时的任务' }] }),
    'run-deleg': fixtureTask({ taskId: 'run-deleg', agentId: FIXTURE_AGENT_B, delegated_from_agent_id: FIXTURE_AGENT_A,
      input: [{ source: 'handoff', author_type: 'agent', author_id: FIXTURE_AGENT_A, content: '请复核预算约束' }] }),
  };
  const transcript = Object.keys(tasks).map((id) => ({ task_id: id, seq: 1, type: 'text', content: `done ${id}` }));
  await withStack({ taskApi: true, tasks, transcript }, async ({ ov, svc, cb }) => {
    for (const id of Object.keys(tasks)) {
      const r = await svc.signedPost('/hooks/memory-archive', archiveBody(cb, 'task.completed',
        taskEvent({ taskId: id, agentId: tasks[id].agent_id, issueId: tasks[id].issue_id ?? '' })));
      assert.equal(r.json.result.status, 'queued', `${id}: ${r.text}`);
    }
    const expect = {
      'run-chat': scopeKey('dm', FIXTURE_WS, FIXTURE_AGENT_A, FIXTURE_USER),
      'run-auto': scopeKey('automation', FIXTURE_WS, 'ap-1'),
      'run-quick': scopeKey('run', FIXTURE_WS, 'run-quick'),
      'run-deleg': taskScope,
    };
    for (const [id, scope] of Object.entries(expect)) {
      const rec = await waitFor(() => svc.registry.get(scope), { label: scope });
      await waitFor(() => ov.archivedOf(rec.apiKey, `mc-task-${id}`).length, { label: `${id} archive` });
    }
    const dm = svc.registry.get(expect['run-chat']);
    const chatMsgs = ov.archivedOf(dm.apiKey, 'mc-task-run-chat');
    const said = chatMsgs.find((m) => /代码注释一律用中文/.test(m.content ?? ''));
    assert.equal(said?.peer_id, FIXTURE_USER, 'the member\'s chat message is attributed to them');

    const channel = await waitFor(() => svc.registry.get(scopeKey('delegation', FIXTURE_WS, FIXTURE_AGENT_A, FIXTURE_AGENT_B)), { label: 'delegation scope' });
    await waitFor(() => ov.archivedOf(channel.apiKey, 'mc-deleg-run-deleg').length, { label: 'handoff archive' });
    assert.match(JSON.stringify(ov.archivedOf(channel.apiKey, 'mc-deleg-run-deleg')), /请复核预算约束/);
  });
});

test('commit tags built from client-supplied ids are always valid OV tags', async () => {
  await withStack({}, async ({ ov, svc, cb }) => {
    const r = await svc.signedPost('/hooks/memory-archive', archiveBody(cb, 'comment.created',
      commentEvent({ id: 'Y2hhdC0xMjM=', content: '回滚演练必须在灰度第一周完成。' })));
    assert.equal(r.json.result.status, 'queued');
    const rec = await waitFor(() => svc.registry.get(taskScope));
    await waitFor(() => ov.archivedOf(rec.apiKey, 'mc-comment-Y2hhdC0xMjM_').length, { label: 'archived despite = in the id' });
    const tags = ov.sessionsOf(rec.apiKey).get('mc-comment-Y2hhdC0xMjM_').tags;
    assert.ok(tags.every((t) => t.split('=').length === 2), JSON.stringify(tags));
  });
});

test('unsigned, wrongly signed or mis-addressed deliveries are refused before any handler runs', async () => {
  await withStack({}, async ({ svc, cb }) => {
    const body = archiveBody(cb, 'comment.created', commentEvent({ content: 'x' }));
    const { postJson } = await import('./helpers.mjs');
    const unsigned = await postJson(svc.port, '/hooks/memory-archive', body);
    assert.equal(unsigned.status, 401);
    const wrong = await svc.signedPost('/hooks/memory-archive', body, { secret: 'whsec_' + '0'.repeat(64) });
    assert.equal(wrong.status, 401);
    // body names one installation, headers another
    const mismatched = await svc.signedPost('/hooks/memory-archive', { ...body, installation_id: 'other-installation' }, { installation: body.installation_id });
    assert.equal(mismatched.status, 401);
    assert.equal(svc.queue.stats().queued + svc.queue.stats().done, 0);
  });
});
