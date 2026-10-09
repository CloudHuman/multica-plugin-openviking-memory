import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobQueue } from '../src/queue.mjs';
import { tempStateDir } from './helpers.mjs';
import { sleep } from '../src/util.mjs';

test('queue processes jobs and persists done state; replay is idempotent', async () => {
  const stateDir = tempStateDir();
  const seen = [];
  const q1 = new JobQueue({ stateDir, handler: async (job) => seen.push(job.payload.x), pollMs: 10, baseDelayMs: 5, log: () => {} });
  q1.start();
  q1.enqueue('t', { x: 1 });
  q1.enqueue('t', { x: 2 });
  await sleep(150);
  await q1.stop();
  assert.deepEqual(seen.sort(), [1, 2]);
  assert.equal(q1.stats().done, 2);

  // Fresh instance over the same journal: nothing re-runs.
  const seen2 = [];
  const q2 = new JobQueue({ stateDir, handler: async (job) => seen2.push(job.payload.x), pollMs: 10, log: () => {} });
  q2.start();
  await sleep(80);
  await q2.stop();
  assert.deepEqual(seen2, []);
});

test('failing jobs back off and eventually mark failed; checkpoints survive', async () => {
  const stateDir = tempStateDir();
  let attempts = 0;
  const q = new JobQueue({
    stateDir,
    maxAttempts: 3,
    baseDelayMs: 5,
    pollMs: 10,
    handler: async (job) => {
      attempts++;
      job.cp.step = attempts;
      throw new Error('transient');
    },
    log: () => {},
  });
  q.start();
  q.enqueue('flaky', { n: 1 });
  await sleep(400);
  await q.stop();
  assert.equal(attempts, 3);
  assert.equal(q.stats().failed, 1);
  const job = q.list().find((j) => j.type === 'flaky');
  assert.equal(job.attempts, 3);
  assert.match(job.last_error, /transient/);
  const replayed = new JobQueue({ stateDir, handler: async () => assert.fail('a failed job must not restart automatically') });
  assert.deepEqual(replayed.jobs.get(job.id).last_error_diagnostic, { source: 'archive-job', category: 'unknown' });
});

test('crash recovery: jobs recorded as running are re-queued on boot', async () => {
  const stateDir = tempStateDir();
  const q1 = new JobQueue({ stateDir, handler: async () => {}, pollMs: 10, log: () => {} });
  const { id } = q1.enqueue('stuck', { x: 9 });
  // Simulate a crash mid-run: forge the journal state directly.
  const job = q1.jobs.get(id);
  job.status = 'running';
  const { appendFileSync } = await import('node:fs');
  appendFileSync(`${stateDir}/queue.ndjson`, `${JSON.stringify({ t: 'update', job })}\n`);

  let ran = 0;
  const q2 = new JobQueue({ stateDir, handler: async () => { ran++; }, pollMs: 10, log: () => {} });
  q2.start();
  await sleep(120);
  await q2.stop();
  assert.equal(ran, 1);
  assert.equal(q2.stats().done, 1);
});

test('regression: queued jobs in a compacted journal are picked up after restart', async () => {
  const stateDir = tempStateDir();
  // q1 shuts down with a queued job → stop() writes a compact-base snapshot.
  const q1 = new JobQueue({ stateDir, handler: async () => {}, pollMs: 10, log: () => {} });
  q1.enqueue('waiting', { x: 1 });
  await sleep(30);
  await q1.stop();

  let ran = 0;
  const q2 = new JobQueue({ stateDir, handler: async (job) => { ran += job.payload.x; }, pollMs: 10, log: () => {} });
  assert.ok(q2.order.length >= 1, 'order rebuilt from compacted journal');
  q2.start();
  await sleep(120);
  await q2.stop();
  assert.equal(ran, 1);
  assert.equal(q2.stats().done, 1);
});

test('dedupeKey blocks duplicate in-flight jobs', async () => {
  const stateDir = tempStateDir();
  let ran = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const q = new JobQueue({ stateDir, handler: async () => { ran++; await gate; }, pollMs: 10, log: () => {} });
  q.start();
  q.enqueue('t', { a: 1 }, { dedupeKey: 'k1' });
  await sleep(30);
  const second = q.enqueue('t', { a: 2 }, { dedupeKey: 'k1' });
  assert.equal(second.reused, true);
  release();
  await sleep(80);
  await q.stop();
  assert.equal(ran, 1);
});

test('dedupeKey also blocks re-enqueue after the job is done (redelivery under a new invocation)', async () => {
  const stateDir = tempStateDir();
  let ran = 0;
  const q = new JobQueue({ stateDir, handler: async () => { ran++; }, pollMs: 10, log: () => {} });
  q.start();
  q.enqueue('t', { a: 1 }, { dedupeKey: 'k1' });
  await sleep(120);
  const second = q.enqueue('t', { a: 2 }, { dedupeKey: 'k1' });
  assert.equal(second.reused, true);
  await sleep(60);
  await q.stop();
  assert.equal(ran, 1);
  assert.equal(q.stats().done, 1);
});

test('a failed record redelivered under its dedupe key runs again as the same job, next generation', async () => {
  const stateDir = tempStateDir();
  let fail = true;
  const runs = [];
  const q = new JobQueue({
    stateDir, maxAttempts: 1, baseDelayMs: 5, pollMs: 10, log: () => {},
    handler: async (job) => {
      runs.push(job.payload.generation);
      if (fail) throw new Error('OV down');
    },
  });
  q.start();
  const first = q.enqueue('archive', { x: 1 }, { dedupeKey: 'rec-1' });
  await sleep(80);
  assert.equal(q.jobs.get(first.id).status, 'failed');

  fail = false;
  const again = q.enqueue('archive', { x: 1 }, { dedupeKey: 'rec-1' });
  assert.deepEqual(again, { id: first.id, reused: false, requeued: true });
  await sleep(80);
  await q.stop();
  assert.equal(q.jobs.size, 1, 'never two jobs racing for one record');
  assert.equal(q.jobs.get(first.id).status, 'done');
  assert.deepEqual(runs, [0, 1], 'the re-run is a new generation (a fresh OV session)');
});

test('a partial archive is upgraded when the complete record arrives; a complete one is not re-run', async () => {
  const stateDir = tempStateDir();
  const seen = [];
  const q = new JobQueue({ stateDir, pollMs: 10, log: () => {}, handler: async (job) => seen.push([job.payload.completeness, job.payload.generation]) });
  q.start();
  const a = q.enqueue('archive', { completeness: 'partial:no-transcript' }, { dedupeKey: 'run-1' });
  await sleep(60);
  const b = q.enqueue('archive', { completeness: 'complete' }, { dedupeKey: 'run-1' });
  assert.equal(b.upgraded, true);
  assert.equal(b.id, a.id);
  await sleep(60);
  const c = q.enqueue('archive', { completeness: 'complete' }, { dedupeKey: 'run-1' });
  assert.equal(c.reused, true);
  await sleep(40);
  await q.stop();
  assert.deepEqual(seen, [['partial:no-transcript', 0], ['complete', 1]]);
});

test('requeue leaves queued and running jobs alone; non-retryable errors fail at once', async () => {
  const stateDir = tempStateDir();
  let calls = 0;
  const q = new JobQueue({
    stateDir, maxAttempts: 5, baseDelayMs: 5, pollMs: 10, log: () => {},
    handler: async () => {
      calls++;
      const e = new Error('HTTP 400 INVALID_ARGUMENT');
      e.retryable = false;
      throw e;
    },
  });
  const { id } = q.enqueue('archive', {});
  assert.equal(q.requeue(id), null, 'still queued: nothing to do');
  q.start();
  await sleep(80);
  await q.stop();
  assert.equal(calls, 1);
  assert.equal(q.jobs.get(id).status, 'failed');
  assert.equal(q.requeue('no-such-job'), null);
});

test('automatic re-drives are counted apart from other requeues', async () => {
  const q = new JobQueue({ stateDir: tempStateDir(), baseDelayMs: 5, pollMs: 10, log: () => {}, handler: async () => {} });
  const { id } = q.enqueue('archive', {});
  q.start();
  await sleep(60);
  // Reindexes requested by memory-remember move the generation, not the re-drive budget.
  for (let i = 0; i < 3; i++) {
    q.requeue(id, { reason: 'memory-remember requested reindex' });
    await sleep(40);
  }
  assert.equal(q.jobs.get(id).payload.generation, 3);
  assert.equal(q.jobs.get(id).payload.autoRedrives, 0);
  q.requeue(id, { reason: 'extraction failed', autoRedrive: true });
  await sleep(40);
  assert.equal(q.jobs.get(id).payload.autoRedrives, 1);
  q.requeue(id, { reason: 'manual redrive' });
  await sleep(40);
  await q.stop();
  assert.equal(q.jobs.get(id).payload.autoRedrives, 0, 'a manual redrive starts the count again');
});

test('compaction never drops a done job that is still pinned (its extraction is being watched)', async () => {
  const stateDir = tempStateDir();
  const pinned = new Set();
  const q = new JobQueue({ stateDir, pollMs: 5, keepDone: 1, log: () => {}, handler: async () => {}, isPinned: (id) => pinned.has(id) });
  q.start();
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(q.enqueue('archive', { i }).id);
  pinned.add(ids[0]);
  await sleep(100);
  await q.stop(); // stop() compacts
  const q2 = new JobQueue({ stateDir, handler: async () => {}, log: () => {} });
  assert.ok(q2.jobs.has(ids[0]), 'pinned job kept');
  assert.ok(q2.jobs.has(ids[3]), 'newest done job kept (keepDone = 1)');
  assert.equal(q2.jobs.has(ids[1]) || q2.jobs.has(ids[2]), false, 'older unpinned done jobs compacted away');
});

test('a failed requeue journal write preserves the failed job so redelivery can retry durably', async () => {
  const stateDir = tempStateDir();
  const queue = new JobQueue({ stateDir, handler: async () => {} });
  const { id } = queue.enqueue('archive', { completeness: 'complete' }, { dedupeKey: 'record' });
  const job = queue.jobs.get(id);
  job.status = 'failed';
  const original = structuredClone(job);
  const journal = queue.path;
  queue.path = stateDir;
  assert.throws(() => queue.enqueue('archive', { completeness: 'complete' }, { dedupeKey: 'record' }), /EISDIR/);
  assert.deepEqual(job, original, 'failed append cannot publish a queued generation');
  queue.path = journal;
  assert.equal(queue.enqueue('archive', { completeness: 'complete' }, { dedupeKey: 'record' }).requeued, true);
  const replayed = new JobQueue({ stateDir, handler: async () => {} });
  assert.equal(replayed.jobs.get(id).payload.generation, 1);
  await queue.stop();
});
