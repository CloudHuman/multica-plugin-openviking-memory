import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeKey } from '../src/scopes.mjs';
import { ExtractionWatcher } from '../src/extraction-watch.mjs';
import { makeArchiveHandler } from '../src/pipeline.mjs';
import { createArchiveProcessing } from '../src/processing.mjs';
import { ArchiveStatusLog } from '../src/ledger.mjs';
import { atomicWriteJson } from '../src/util.mjs';
import { writeFileSync } from 'node:fs';
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

test('expired extraction preserves model error and stage from the durable failure marker', async () => {
  const stateDir = tempStateDir();
  const statusLog = new ArchiveStatusLog({ stateDir });
  const ov = {
    async getTask() { throw Object.assign(new Error('expired'), { status: 404 }); },
    async readContent(key, uri) {
      if (uri.endsWith('/.done')) throw Object.assign(new Error('not found'), { status: 404 });
      return { content: JSON.stringify({ stage: 'archive_summary', error: 'Error code: 401 - Missing Authentication header' }) };
    },
  };
  const watcher = new ExtractionWatcher({ ov, registry: { get: () => ({ apiKey: 'key' }) }, stateDir, statusLog,
    cfg: { extractPollIntervalMs: 1, extractPollMaxIntervalMs: 2, extractMaxWatchMs: 1000, extractMaxRedrives: 0 } });
  watcher.watch({ jobId: 'j', workspaceId: 'w', scopeKey: 'task:w:i', sessionId: 's', ref: 'r', taskId: 't', type: 'archive-run', archiveUri: 'viking://user/u/sessions/s/history/archive_001' });
  watcher.pending.s.nextCheckAt = 0;
  await watcher.tick();
  watcher.stop();
  const result = statusLog.recent()[0];
  assert.equal(result.extraction, 'failed');
  assert.match(result.error, /Missing Authentication header/);
  assert.deepEqual(result.error_diagnostic, { source: 'archive-marker', category: 'authentication', provider_status: 401, provider_auth_reason: 'no_bearer_token', stage: 'archive_summary' });
});

for (const failureSource of ['task', 'marker']) {
  test(`${failureSource} polling auth errors persist through restart, stay pending and recover without redrive`, async () => {
    const stateDir = tempStateDir();
    const statusLog = new ArchiveStatusLog({ stateDir });
    let refused = true;
    let redrives = 0;
    const unavailable = () => { throw Object.assign(new Error('HTTP 401 invalid key Bearer private-key'), { status: 401 }); };
    const ov = {
      async getTask() {
        if (failureSource === 'task') { if (refused) unavailable(); return { status: 'completed' }; }
        throw Object.assign(new Error('expired'), { status: 404 });
      },
      async readContent() { if (refused) unavailable(); return { content: '' }; },
    };
    const deps = { ov, registry: { get: () => ({ apiKey: 'private-key' }) }, queue: { requeue() { redrives++; } }, stateDir, statusLog,
      cfg: { extractPollIntervalMs: 1000, extractPollMaxIntervalMs: 2000, extractMaxWatchMs: 60_000, extractMaxRedrives: 1 } };
    let watcher = new ExtractionWatcher(deps);
    watcher.watch({ jobId: 'j', workspaceId: 'w', scopeKey: 'task:w:i', sessionId: 's', ref: 'r', taskId: 't', type: 'archive-run', archiveUri: 'viking://user/u/sessions/s/history/archive_001' });
    watcher.pending.s.nextCheckAt = 0;
    await watcher.tick();
    watcher.stop();
    assert.deepEqual(watcher.stats({ workspaceId: 'w' }), { pending: 1, polling_errors: 1 });
    assert.deepEqual(watcher.stats({ workspaceId: 'other' }), { pending: 0, polling_errors: 0 });
    assert.equal(statusLog.recent()[0].type, 'extraction-poll-error');
    assert.equal(statusLog.recent()[0].error_diagnostic.http_status, 401);
    assert.ok(!JSON.stringify(statusLog.recent()).includes('private-key'));
    watcher = new ExtractionWatcher(deps);
    assert.equal(watcher.stats().polling_errors, 1);
    watcher.pending.s.nextCheckAt = 0;
    await watcher.tick();
    watcher.stop();
    assert.equal(statusLog.recent().length, 1, 'unchanged errors do not flood the status log');
    refused = false;
    watcher.pending.s.nextCheckAt = 0;
    await watcher.tick();
    watcher.stop();
    assert.equal(statusLog.recent()[0].extraction, 'done');
    assert.equal(watcher.stats().polling_errors, 0);
    assert.equal(redrives, 0, 'polling failure is not an extraction failure');
  });
}

test('extraction timeout retains the last polling failure', async () => {
  const stateDir = tempStateDir();
  const statusLog = new ArchiveStatusLog({ stateDir });
  const watcher = new ExtractionWatcher({
    ov: { async getTask() { throw Object.assign(new Error('HTTP 401 unauthorized'), { status: 401 }); } },
    registry: { get: () => ({ apiKey: 'k' }) }, stateDir, statusLog,
    cfg: { extractPollIntervalMs: 1000, extractMaxWatchMs: 1 },
  });
  watcher.watch({ jobId: 'j', workspaceId: 'w', scopeKey: 'task:w:i', sessionId: 's', ref: 'r', taskId: 't', type: 'archive-run' });
  watcher.pending.s.nextCheckAt = 0;
  watcher.pending.s.startedAt = Date.now() - 1000;
  await watcher.tick();
  watcher.stop();
  const result = statusLog.recent()[0];
  assert.equal(result.extraction, 'timeout');
  assert.match(result.error, /401/);
  assert.equal(result.error_diagnostic.category, 'authentication');
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

for (const outcome of ['done', 'failed', 'pending']) {
  test(`lost commit response with an expired task recovers ${outcome} from the durable archive`, async () => {
    const stateDir = tempStateDir();
    const statusLog = new ArchiveStatusLog({ stateDir });
    const rec = { apiKey: 'k', userId: 'u' };
    const uri = 'viking://user/u/sessions/mc-comment-expired/history/archive_002';
    let redrives = 0;
    const ov = {
      async getSession() { return { commit_count: 2, message_count: 0 }; },
      async listTasks() { return []; },
      async getTask() { assert.fail('there is no task ID to poll'); },
      async readContent(key, path) {
        if (path === `${uri}/.${outcome === 'done' ? 'done' : 'failed.json'}` && outcome !== 'pending') return { content: '{}' };
        const err = new Error('not found'); err.status = 404; throw err;
      },
    };
    const registry = { ensureForArchive: async () => rec, get: () => rec };
    const cfg = { extractPollIntervalMs: 1, extractPollMaxIntervalMs: 2, extractMaxWatchMs: 1000, extractMaxRedrives: 1, extractRedriveDelayMs: 0 };
    const queue = { requeue: () => { redrives++; return { payload: { generation: 1 } }; } };
    const watcher = new ExtractionWatcher({ ov, registry, queue, statusLog, stateDir, cfg });
    const job = { id: 'expired-job', type: 'archive-comment', cp: {}, payload: {
      workspaceId: FIXTURE_WS, scopeKey: taskScope, refId: 'expired',
      comment: { id: 'expired', author_type: 'member', content: '退款必须在三个工作日内到账。' },
    } };
    try {
      await makeArchiveHandler({ ov, registry, statusLog, extractions: watcher, cfg })(job);
      assert.equal(job.cp.archiveUri, uri, 'recover the latest numbered archive even after task TTL');
      assert.equal(watcher.stats().pending, 1, 'pending means a persisted watch exists');
      const entry = Object.values(watcher.pending)[0];
      entry.nextCheckAt = 0;
      if (outcome === 'pending') entry.startedAt = Date.now() - 2000;
      await watcher.tick();
      const settled = statusLog.recent({ limit: 10 }).find((e) => e.type === 'extraction');
      assert.equal(settled.extraction, outcome === 'failed' ? 'redriven' : outcome === 'pending' ? 'timeout' : 'done');
      assert.equal(redrives, outcome === 'failed' ? 1 : 0);
      assert.equal(watcher.stats().pending, 0);
    } finally {
      watcher.stop();
    }
  });
}

test('restart replay loads extraction pins before compacting more than 500 completed jobs', async () => {
  const stateDir = tempStateDir();
  const jobs = Array.from({ length: 511 }, (_, i) => ({
    id: `j${i}`, type: 'archive-comment', cp: {}, status: i === 510 ? 'running' : 'done',
    payload: { generation: 0, workspaceId: FIXTURE_WS, refId: `r${i}` },
    created_at: new Date(i * 1000).toISOString(),
  }));
  writeFileSync(`${stateDir}/queue.ndjson`, JSON.stringify({ t: 'compact-base', jobs }) + '\n');
  atomicWriteJson(`${stateDir}/extractions.json`, { pending: { s0: { jobId: 'j0', sessionId: 's0', nextCheckAt: Date.now() + 60_000 } } });
  const { queue, extractions } = createArchiveProcessing({ ov: {}, registry: {}, statusLog: new ArchiveStatusLog({ stateDir }), cfg: { stateDir } });
  try {
    assert.ok(queue.jobs.has('j0'), 'oldest pending extraction retains its redrive payload');
    assert.equal(queue.jobs.get('j510').status, 'queued', 'in-flight job is recovered too');
    assert.equal(queue.jobs.size, 502, '500 unpinned completed jobs plus one pinned and one recovered job');
    assert.equal(queue.requeue('j0', { reason: 'recovered extraction failed' }).payload.generation, 1);
  } finally {
    extractions.stop();
    await queue.stop();
  }
});
