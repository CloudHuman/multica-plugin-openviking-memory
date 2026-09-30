import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeKey } from '../src/scopes.mjs';
import { ExtractionWatcher } from '../src/extraction-watch.mjs';
import { ArchiveStatusLog } from '../src/ledger.mjs';
import {
  startFakeOv, startFakeMultica, fixtureIssue, hookBody, commentEvent, tempStateDir,
  FIXTURE_WS, FIXTURE_ISSUE_ID,
} from './helpers.mjs';
import { bootService, waitFor } from './harness.mjs';

// Extraction is watched beside the queue, and a failed extraction is re-driven
// the only way OpenViking allows: the same record in a FRESH session. The old
// "POST /extract after commit" ran over zero live messages and reported success.

const taskScope = scopeKey('task', FIXTURE_WS, FIXTURE_ISSUE_ID);

async function archiveOneComment({ ovOpts, cfg, id = 'cm-x' } = {}) {
  const ov = await startFakeOv(ovOpts);
  const multica = await startFakeMultica({ issue: fixtureIssue() });
  const svc = await bootService({ ov, cfg });
  const r = await svc.signedPost('/hooks/memory-archive', hookBody({ eventType: 'comment.created', callbackUrl: multica.baseUrl + '/v1',
    input: commentEvent({ id, content: '约定: 发布窗口只在周二和周四。' }) }));
  assert.equal(r.json.result.status, 'queued', r.text);
  return {
    ov, multica, svc,
    async stop() { await svc.stop(); await multica.stop(); await ov.stop(); },
  };
}

const extractionStates = (svc, ref) => svc.statusLog.recent({ limit: 50 }).filter((e) => e.type === 'extraction' && e.ref === ref).reverse().map((e) => e.extraction);

test('a failed extraction is re-driven in a fresh session and ends up extracted', async () => {
  const run = await archiveOneComment({ ovOpts: { taskBehavior: 'fail-first' } });
  try {
    const { ov, svc } = run;
    await waitFor(() => extractionStates(svc, 'cm-x').includes('done'), { label: 'extraction done after re-drive' });
    assert.deepEqual(extractionStates(svc, 'cm-x'), ['redriven', 'done']);

    const rec = svc.registry.get(taskScope);
    assert.ok(ov.sessionsOf(rec.apiKey).has('mc-comment-cm-x'), 'generation 0 session');
    assert.ok(ov.sessionsOf(rec.apiKey).has('mc-comment-cm-x-r1'), 're-drive used a fresh session');
    assert.ok([...ov.filesOf(rec.apiKey).keys()].some((u) => u.endsWith('/memories/events/mc-comment-cm-x-r1.md')), 'the re-drive produced a memory');
    assert.equal(ov.spaces.get(rec.apiKey).extracts.length, 0, 'POST /extract (a no-op after commit) is never used');
  } finally {
    await run.stop();
  }
});

test('a record whose extraction keeps failing ends as failed once the re-drive budget is spent', async () => {
  const run = await archiveOneComment({ ovOpts: { taskBehavior: 'fail-always' }, cfg: { extractMaxRedrives: 1 } });
  try {
    await waitFor(() => extractionStates(run.svc, 'cm-x').includes('failed'), { label: 'final failure' });
    assert.deepEqual(extractionStates(run.svc, 'cm-x'), ['redriven', 'failed']);
    const last = run.svc.statusLog.recent({ limit: 50 }).find((e) => e.type === 'extraction' && e.extraction === 'failed');
    assert.match(last.error, /429/);
  } finally {
    await run.stop();
  }
});

test('/admin/redrive runs a record again in a new generation', async () => {
  const run = await archiveOneComment();
  try {
    const { svc, ov } = run;
    await waitFor(() => extractionStates(svc, 'cm-x').includes('done'));
    const r = await svc.admin('/admin/redrive', { session_id: 'mc-comment-cm-x' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.result.generation, 1);
    const rec = svc.registry.get(taskScope);
    await waitFor(() => ov.sessionsOf(rec.apiKey).has('mc-comment-cm-x-r1'), { label: 'redriven session' });
    const missing = await svc.admin('/admin/redrive', { job_id: 'nope' });
    assert.equal(missing.status, 404);
  } finally {
    await run.stop();
  }
});

test('when OV no longer knows a task, the archive\'s own .done / .failed.json markers decide', async () => {
  const ov = await startFakeOv();
  try {
    const stateDir = tempStateDir();
    const statusLog = new ArchiveStatusLog({ stateDir });
    const rec = { apiKey: 'k', userId: 'u' };
    const files = new Set(['viking://user/u/sessions/s1/history/archive_001/.done', 'viking://user/u/sessions/s2/history/archive_001/.failed.json']);
    const fakeOv = {
      async getTask() { const e = new Error('no task'); e.status = 404; throw e; },
      async readContent(key, uri) { if (!files.has(uri)) { const e = new Error('nf'); e.status = 404; throw e; } return { content: '{}' }; },
    };
    const queue = { requeue: () => null };
    const cfg = { extractPollIntervalMs: 1, extractPollMaxIntervalMs: 2, extractMaxWatchMs: 60_000, extractMaxRedrives: 0, extractRedriveDelayMs: 0 };
    const w = new ExtractionWatcher({ ov: fakeOv, registry: { get: () => rec }, queue, statusLog, stateDir, cfg });
    w.watch({ jobId: 'j1', workspaceId: FIXTURE_WS, scopeKey: 'task:w:i', sessionId: 's1', ref: 'r1', type: 'archive-comment', taskId: 't1', archiveUri: 'viking://user/u/sessions/s1/history/archive_001' });
    w.watch({ jobId: 'j2', workspaceId: FIXTURE_WS, scopeKey: 'task:w:i', sessionId: 's2', ref: 'r2', type: 'archive-comment', taskId: 't2', archiveUri: 'viking://user/u/sessions/s2/history/archive_001' });
    for (const e of Object.values(w.pending)) e.nextCheckAt = 0;
    await w.tick();
    w.stop();
    const states = Object.fromEntries(statusLog.recent({ limit: 10 }).map((e) => [e.ref, e.extraction]));
    assert.deepEqual(states, { r1: 'done', r2: 'failed' });
    assert.equal(w.stats().pending, 0);
  } finally {
    await ov.stop();
  }
});

test('a lost commit response is recovered from OV, not committed twice', async () => {
  const run = await archiveOneComment();
  try {
    const { svc, ov } = run;
    await waitFor(() => extractionStates(svc, 'cm-x').includes('done'));
    const rec = svc.registry.get(taskScope);
    // Simulate a retry after the commit landed but its response was lost.
    const job = [...svc.queue.jobs.values()].find((j) => j.payload.refId === 'cm-x');
    job.cp = {};
    job.status = 'failed';
    const commitsBefore = ov.calls.filter((c) => c.path.endsWith('/commit')).length;
    svc.queue.jobs.get(job.id).payload.generation = -1; // requeue bumps to generation 0: the SAME session
    svc.queue.requeue(job.id, { reason: 'test: lost response' });
    await waitFor(() => svc.queue.jobs.get(job.id).status === 'done', { label: 'job settled' });
    const commitsAfter = ov.calls.filter((c) => c.path.endsWith('/commit')).length;
    assert.equal(commitsAfter, commitsBefore, 'no second commit of the same session');
    assert.equal(ov.archivedOf(rec.apiKey, 'mc-comment-cm-x').length, 1, 'no duplicated messages');
  } finally {
    await run.stop();
  }
});
