import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeKey } from '../src/scopes.mjs';
import { validateStartupConfig, parseSigningSecrets, DEFAULTS } from '../src/config.mjs';
import { planExtractionBatches, messageTokens } from '../src/pipeline.mjs';
import {
  startFakeOv, startFakeMultica, fixtureIssue, fixtureTask, hookBody, commentEvent, taskEvent,
  FIXTURE_WS, FIXTURE_ISSUE_ID, FIXTURE_AGENT_A,
} from './helpers.mjs';
import { bootService, waitFor } from './harness.mjs';

// With an install token the hook only registers a finished run; a queue job then
// reads the whole transcript (no hook deadline, no 2000-message cap) and archives
// it. A record too large for one extraction is extracted in OpenViking batches,
// each opening with the record's context.

const TOKEN = `mpi_${'a'.repeat(32)}`;
const taskScope = scopeKey('task', FIXTURE_WS, FIXTURE_ISSUE_ID);

/** A long run: text steps and tool calls, ending in the conclusion. */
function longTranscript(taskId, steps) {
  const t = [];
  let seq = 0;
  const push = (msg) => t.push({ task_id: taskId, created_at: new Date().toISOString(), ...msg });
  for (let i = 0; i < steps; i++) {
    push({ seq: ++seq, type: 'text', content: `第 ${i} 步：检查 orders 分片 ${i}。` });
    push({ seq: ++seq, type: 'tool_use', tool: 'bash', call_id: `c${i}`, input: { command: `kubectl logs orders-${i}` } });
    push({ seq: ++seq, type: 'tool_result', tool: 'bash', call_id: `c${i}`, output: `shard ${i} ok` });
  }
  push({ seq: ++seq, type: 'text', content: '结论：所有分片的重试上限统一为 5 次，死信队列保留 7 天。' });
  return t;
}

async function withBackground({ taskId, transcript, cfg = {}, multicaOpts = {}, ovOpts = {} }, fn) {
  const ov = await startFakeOv(ovOpts);
  const multica = await startFakeMultica({
    issue: fixtureIssue(), tasks: { [taskId]: fixtureTask({ taskId }) }, transcript, taskApi: true, ...multicaOpts,
  });
  const svc = await bootService({ ov, cfg: { multicaApiUrl: `${multica.baseUrl}/v1`, multicaToken: TOKEN, ...cfg } });
  try {
    await fn({ ov, multica, svc, cb: `${multica.baseUrl}/v1` });
  } finally {
    await svc.stop();
    await multica.stop();
    await ov.stop();
  }
}

const runArchive = async (ov, svc, taskId) => {
  const rec = await waitFor(() => svc.registry.get(taskScope), { label: 'task scope' });
  return waitFor(() => {
    const archived = ov.archivedOf(rec.apiKey, `mc-task-${taskId}`);
    return archived.length ? { rec, archived } : null;
  }, { label: 'run archive', timeoutMs: 8000 });
};

test('with an install token the hook registers the run and a queue job archives the whole transcript', async () => {
  const taskId = 'run-bg-1';
  // 2,401 messages: past the hook path's 2,000-message cap and over 12 pages.
  const transcript = longTranscript(taskId, 800);
  await withBackground({ taskId, transcript }, async ({ ov, multica, svc, cb }) => {
    const res = await svc.signedPost('/hooks/memory-archive', hookBody({ eventType: 'task.completed', input: taskEvent({ taskId }), callbackUrl: cb }));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.result.status, 'queued');
    assert.equal(res.json.result.fetch, 'background');

    const { archived } = await runArchive(ov, svc, taskId);
    const text = JSON.stringify(archived);
    assert.ok(text.includes('结论：所有分片的重试上限统一为 5 次'), 'the end of the run is archived');
    assert.ok(text.includes('第 0 步') && text.includes('第 799 步'));
    assert.equal(archived.filter((m) => m.message_kind === 'tool_transport').length, 800, 'every tool result');

    // The run was read with the install token, not the hook's callback token.
    const reads = multica.requests.filter((r) => r.path.startsWith('/v1/tasks/'));
    assert.ok(reads.length >= 13);
    assert.ok(reads.every((r) => r.token.startsWith('Bearer mpi_')), JSON.stringify(reads.slice(0, 3)));

    const accepted = svc.statusLog.recent({ limit: 20 }).find((e) => e.event === 'task.completed' && e.ref === taskId && e.kind);
    assert.equal(accepted?.completeness, 'complete');
  });
});

test('a record too large for one extraction is batched, and every batch opens with the run\'s context', async () => {
  const taskId = 'run-bg-2';
  const limit = 4_000;
  await withBackground({ taskId, transcript: longTranscript(taskId, 300), cfg: { extractBatchTokens: limit } }, async ({ ov, svc, cb }) => {
    await svc.signedPost('/hooks/memory-archive', hookBody({ eventType: 'task.completed', input: taskEvent({ taskId }), callbackUrl: cb }));
    const { rec, archived } = await runArchive(ov, svc, taskId);
    const session = ov.sessionsOf(rec.apiKey).get(`mc-task-${taskId}`);
    assert.equal(session.archives.length, 1, 'one commit');
    // Bounded by tokens alone: OpenViking's default message limit is switched off.
    assert.deepEqual(session.archives[0].autoCommit, { message_count_threshold: 0, pending_token_threshold: limit });
    const entry = await waitFor(() => svc.statusLog.recent({ limit: 20 }).find((e) => e.session_id === `mc-task-${taskId}` && e.extraction === 'pending'));
    const contexts = archived.map((m, i) => (m.message_kind === 'user_query' ? i : -1)).filter((i) => i >= 0);
    assert.ok(entry.extraction_batches > 1);
    assert.equal(contexts.length, entry.extraction_batches, 'one context message per batch');
    assert.equal(contexts[0], 0);
    for (const i of contexts) assert.match(archived[i].content, /任务描述/);
    // Each segment fits well inside one batch, so none is cut off its context.
    contexts.forEach((start, k) => {
      const segment = archived.slice(start, contexts[k + 1] ?? archived.length);
      assert.ok(segment.reduce((n, m) => n + messageTokens(m), 0) <= limit * 0.8, `segment ${k + 1}`);
    });
    assert.ok(JSON.stringify(archived).includes('结论：所有分片的重试上限统一为 5 次'));
  });
});

test('a record within one extraction is extracted whole: no context copies, no policy', async () => {
  const taskId = 'run-bg-2b';
  await withBackground({ taskId, transcript: longTranscript(taskId, 300) }, async ({ ov, svc, cb }) => {
    await svc.signedPost('/hooks/memory-archive', hookBody({ eventType: 'task.completed', input: taskEvent({ taskId }), callbackUrl: cb }));
    const { rec, archived } = await runArchive(ov, svc, taskId);
    assert.equal(ov.sessionsOf(rec.apiKey).get(`mc-task-${taskId}`).archives[0].autoCommit, null);
    assert.equal(archived.filter((m) => m.message_kind === 'user_query').length, 1);
    const entry = await waitFor(() => svc.statusLog.recent({ limit: 20 }).find((e) => e.session_id === `mc-task-${taskId}` && e.extraction === 'pending'));
    assert.equal(entry.extraction_batches, undefined);
  });
});

test('a batch limit above OpenViking\'s 1,000,000-token cap cuts segments at the cap', () => {
  const context = { role: 'user', message_kind: 'user_query', content: '[Multica 任务] 「巡检」' };
  const steps = Array.from({ length: 30 }, () => ({ role: 'assistant', parts: [{ type: 'text', text: 'x'.repeat(400_000) }] })); // 100,000 tokens each
  const plan = planExtractionBatches([context, ...steps], { extractBatchTokens: 5_000_000 });
  assert.ok(plan.batches > 1, 'a 3,000,000-token record is batched');
  const contexts = plan.messages.map((m, i) => (m.message_kind === 'user_query' ? i : -1)).filter((i) => i >= 0);
  contexts.forEach((start, k) => {
    const segment = plan.messages.slice(start, contexts[k + 1] ?? plan.messages.length);
    assert.ok(segment.reduce((n, m) => n + messageTokens(m), 0) <= 800_000);
  });
});

test('a record that does not open with its context (a member chat) is never batched', () => {
  const chat = [
    { role: 'user', peer_id: 'member-1', content: '以后回复都用中文。' },
    ...Array.from({ length: 400 }, (_, i) => ({ role: 'assistant', parts: [{ type: 'text', text: `第 ${i} 段回复，内容较长。`.repeat(20) }] })),
  ];
  const plan = planExtractionBatches(chat, { extractBatchTokens: 1_000 });
  assert.equal(plan.batches, 1);
  assert.equal(plan.messages, chat);
});

test('an OpenViking without the session config endpoint still archives the long record, in one batch', async () => {
  const taskId = 'run-bg-3';
  await withBackground({ taskId, transcript: longTranscript(taskId, 300), cfg: { extractBatchTokens: 4_000 }, ovOpts: { sessionConfig: false } }, async ({ ov, svc, cb }) => {
    await svc.signedPost('/hooks/memory-archive', hookBody({ eventType: 'task.completed', input: taskEvent({ taskId }), callbackUrl: cb }));
    const { rec } = await runArchive(ov, svc, taskId);
    const session = ov.sessionsOf(rec.apiKey).get(`mc-task-${taskId}`);
    assert.equal(session.archives.length, 1);
    assert.equal(session.archives[0].autoCommit, null);
    const entry = await waitFor(() => svc.statusLog.recent({ limit: 20 }).find((e) => e.session_id === `mc-task-${taskId}` && e.extraction === 'pending'));
    assert.equal(entry.extraction_batches, undefined);
  });
});

test('a page that fails mid-read is retried whole: the run is never archived half-read', async () => {
  const taskId = 'run-bg-4';
  const transcript = longTranscript(taskId, 200); // 601 messages, 4 pages
  await withBackground({ taskId, transcript, multicaOpts: { messageFaults: [{ page: 2, status: 502 }] } }, async ({ ov, svc, cb }) => {
    await svc.signedPost('/hooks/memory-archive', hookBody({ eventType: 'task.completed', input: taskEvent({ taskId }), callbackUrl: cb }));
    const { archived } = await runArchive(ov, svc, taskId);
    assert.ok(JSON.stringify(archived).includes('结论：所有分片的重试上限统一为 5 次'));
    assert.equal(archived.filter((m) => m.message_kind === 'tool_transport').length, 200);
    const accepted = svc.statusLog.recent({ limit: 30 }).find((e) => e.event === 'task.completed' && e.ref === taskId && e.kind);
    assert.equal(accepted.completeness, 'complete');
  });
});

test('run details that stay unavailable are retried, never archived without the run\'s input', async () => {
  const taskId = 'run-bg-7';
  const ov = await startFakeOv();
  const multica = await startFakeMultica({ issue: fixtureIssue(), tasks: { [taskId]: 'unavailable' }, transcript: longTranscript(taskId, 3), taskApi: true });
  const svc = await bootService({ ov, cfg: { multicaApiUrl: `${multica.baseUrl}/v1`, multicaToken: TOKEN } });
  try {
    await svc.signedPost('/hooks/memory-archive', hookBody({ eventType: 'task.completed', input: taskEvent({ taskId }), callbackUrl: `${multica.baseUrl}/v1` }));
    const job = await waitFor(() => {
      const j = svc.queue.findByDedupeKey(`fetch-run:${FIXTURE_WS}:${taskId}`);
      return j?.status === 'failed' ? j : null;
    }, { label: 'fetch job out of attempts' });
    assert.equal(job.attempts, 3, 'retried up to the attempt limit');
    assert.equal(svc.queue.findByDedupeKey(`archive-run:${FIXTURE_WS}:${taskId}`), null, 'no partial archive');
  } finally {
    await svc.stop();
    await multica.stop();
    await ov.stop();
  }
});

test('a rejected install token fails the read with a message that says how to fix it, and archives nothing', async () => {
  const taskId = 'run-bg-5';
  await withBackground({ taskId, transcript: longTranscript(taskId, 3), multicaOpts: { rejectInstallToken: true } }, async ({ ov, svc, cb }) => {
    const res = await svc.signedPost('/hooks/memory-archive', hookBody({ eventType: 'task.completed', input: taskEvent({ taskId }), callbackUrl: cb }));
    assert.equal(res.json.result.status, 'queued');
    const job = await waitFor(() => {
      const j = svc.queue.findByDedupeKey(`fetch-run:${FIXTURE_WS}:${taskId}`);
      return j?.status === 'failed' ? j : null;
    }, { label: 'failed fetch job' });
    assert.equal(job.attempts, 1, 'not retried');
    assert.match(job.last_error, /rejected the install token \(401\).*rotate the plugin token/);
    assert.equal(svc.queue.findByDedupeKey(`archive-run:${FIXTURE_WS}:${taskId}`), null);
    assert.equal(ov.calls.filter((c) => c.path.includes(`mc-task-${taskId}`)).length, 0);
  });
});

test('an agent\'s closing comment that arrives first waits for its run, and is skipped when the run archive covers it', async () => {
  const taskId = 'run-bg-6';
  const transcript = longTranscript(taskId, 5);
  const closing = transcript[transcript.length - 1].content;
  await withBackground({ taskId, transcript }, async ({ ov, svc, cb }) => {
    const covered = commentEvent({ id: 'cm-covered', content: closing, authorType: 'agent', authorId: FIXTURE_AGENT_A, sourceTaskId: taskId });
    const extra = commentEvent({ id: 'cm-extra', content: '补充：周五前完成灰度。', authorType: 'agent', authorId: FIXTURE_AGENT_A, sourceTaskId: taskId });
    for (const c of [covered, extra]) {
      const r = await svc.signedPost('/hooks/memory-archive', hookBody({ eventType: 'comment.created', input: c, callbackUrl: cb }));
      assert.equal(r.json.result.status, 'queued', r.text);
    }
    // The comment jobs wait (deferred, not failed) until the run is read.
    await waitFor(() => svc.queue.findByDedupeKey(`archive-comment:${FIXTURE_WS}:cm-covered`)?.last_error?.startsWith('deferred'), { label: 'deferred comment' });

    await svc.signedPost('/hooks/memory-archive', hookBody({ eventType: 'task.completed', input: taskEvent({ taskId }), callbackUrl: cb }));
    const { rec } = await runArchive(ov, svc, taskId);
    await waitFor(() => ov.archivedOf(rec.apiKey, 'mc-comment-cm-extra').length, { label: 'uncovered comment archived' });
    await waitFor(() => svc.queue.findByDedupeKey(`archive-comment:${FIXTURE_WS}:cm-covered`)?.status === 'done', { label: 'covered comment settled' });
    assert.equal(ov.archivedOf(rec.apiKey, 'mc-comment-cm-covered').length, 0, 'covered by the run archive');
    const job = svc.queue.findByDedupeKey(`archive-comment:${FIXTURE_WS}:cm-covered`);
    assert.equal(job.attempts, 0, 'waiting spent no attempts');
  });
});

test('install tokens are checked at startup: format, an operator-set Multica URL, and one owner', () => {
  const base = { ...DEFAULTS, ovBaseUrl: 'http://ov', ovRootKey: 'k', pluginToken: 't', signingSecret: `whsec_${'a'.repeat(64)}` };
  assert.deepEqual(validateStartupConfig({ ...base, multicaToken: TOKEN, multicaApiUrl: 'https://mc.example.com/v1' }), []);
  assert.match(validateStartupConfig({ ...base, multicaToken: TOKEN }).join('\n'), /OVMEM_MULTICA_API_URL is not/);
  assert.match(validateStartupConfig({ ...base, multicaToken: 'mpc_short', multicaApiUrl: 'https://mc.example.com/v1' }).join('\n'), /install token \(mpi_…\)/);
  const keyed = parseSigningSecrets({ inst: { secret: `whsec_${'b'.repeat(64)}`, workspace_id: 'ws', token: TOKEN } });
  assert.equal(keyed.inst.token, TOKEN);
  assert.deepEqual(validateStartupConfig({ ...base, signingSecret: '', signingSecrets: keyed, multicaApiUrl: 'https://mc.example.com/v1' }), []);
  assert.match(validateStartupConfig({ ...base, signingSecret: '', signingSecrets: keyed, multicaToken: TOKEN, multicaApiUrl: 'https://mc.example.com/v1' }).join('\n'), /OVMEM_MULTICA_TOKEN belongs to/);
});
