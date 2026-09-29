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
