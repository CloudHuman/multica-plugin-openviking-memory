import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { acquireStateLock } from '../src/state-lock.mjs';
import { tempStateDir } from './helpers.mjs';
import { sleep } from '../src/util.mjs';

// Two services on one state dir corrupt each other's journal. In containers
// every service is PID 1, so liveness is decided by a moving heartbeat.

const fast = { ttlMs: 1_000, heartbeatMs: 30 };
const lockPath = (dir) => join(dir, 'service.lock');

test('a second writer is refused while the first one\'s heartbeat moves', async () => {
  const stateDir = tempStateDir();
  const first = await acquireStateLock({ stateDir, ...fast });
  try {
    // Same host and same PID as the holder: exactly what a twin container
    // sharing the hostname looks like. The live heartbeat gives it away.
    await assert.rejects(() => acquireStateLock({ stateDir, ...fast }), (e) => e.code === 'STATE_LOCKED');
  } finally {
    first.release();
  }
});

test('a lease whose heartbeat stopped is taken over, fresh-looking or not', async () => {
  const stateDir = tempStateDir();
  // A holder on another host that crashed a moment ago: its timestamp is recent but never moves.
  writeFileSync(lockPath(stateDir), JSON.stringify({ instance: 'crashed', pid: 1, host: 'other-host', heartbeatAt: Date.now() }));
  const lock = await acquireStateLock({ stateDir, ...fast });
  assert.notEqual(JSON.parse(readFileSync(lockPath(stateDir), 'utf8')).instance, 'crashed');
  lock.release();

  // Long expired: taken at once.
  writeFileSync(lockPath(stateDir), JSON.stringify({ instance: 'old', pid: 1, host: 'other-host', heartbeatAt: Date.now() - 60_000 }));
  const t0 = Date.now();
  const lock2 = await acquireStateLock({ stateDir, ...fast });
  assert.ok(Date.now() - t0 < 250, 'no watch for an expired lease, only the short settle after taking it');
  lock2.release();
});

test('a lock left by a dead process on this host, or a legacy bare-PID file, is stale', async () => {
  const stateDir = tempStateDir();
  writeFileSync(lockPath(stateDir), JSON.stringify({ instance: 'dead', pid: 2 ** 22 + 12345, host: hostname(), heartbeatAt: Date.now() }));
  const t0 = Date.now();
  const lock = await acquireStateLock({ stateDir, ...fast });
  assert.ok(Date.now() - t0 < 250, 'a provably dead holder is not watched');
  lock.release();

  writeFileSync(lockPath(stateDir), String(process.pid));
  const lock2 = await acquireStateLock({ stateDir, ...fast });
  lock2.release();
});

test('the holder notices a takeover and stops; release removes only its own lease', async () => {
  const stateDir = tempStateDir();
  let lost = null;
  const lock = await acquireStateLock({ stateDir, ...fast, onLost: (by) => { lost = by; } });
  writeFileSync(lockPath(stateDir), JSON.stringify({ instance: 'usurper', pid: 7, host: 'elsewhere', heartbeatAt: Date.now() }));
  await sleep(fast.heartbeatMs * 3);
  assert.equal(lost?.instance, 'usurper');
  lock.release();
  assert.ok(existsSync(lockPath(stateDir)), 'someone else\'s lease is left alone');

  const stateDir2 = tempStateDir();
  const mine = await acquireStateLock({ stateDir: stateDir2, ...fast });
  mine.release();
  assert.equal(existsSync(lockPath(stateDir2)), false);
});

test('of two writers starting together, only one gets the lease', async () => {
  // No lock yet: only one exclusive create succeeds.
  const stateDir = tempStateDir();
  const both = await Promise.allSettled([acquireStateLock({ stateDir, ...fast }), acquireStateLock({ stateDir, ...fast })]);
  assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(both.find((r) => r.status === 'rejected').reason.code, 'STATE_LOCKED');
  both.find((r) => r.status === 'fulfilled').value.release();

  // An expired lease taken over by both: the last write wins, the other refuses.
  const stateDir2 = tempStateDir();
  writeFileSync(lockPath(stateDir2), JSON.stringify({ instance: 'old', pid: 1, host: 'other-host', heartbeatAt: Date.now() - 60_000 }));
  const takers = await Promise.allSettled([acquireStateLock({ stateDir: stateDir2, ...fast }), acquireStateLock({ stateDir: stateDir2, ...fast })]);
  assert.equal(takers.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(takers.find((r) => r.status === 'rejected').reason.code, 'STATE_LOCKED');
  takers.find((r) => r.status === 'fulfilled').value.release();
});


test('a writer that loses a takeover to another process refuses instead of writing on', async () => {
  const stateDir = tempStateDir();
  writeFileSync(lockPath(stateDir), JSON.stringify({ instance: 'old', pid: 1, host: 'other-host', heartbeatAt: Date.now() - 60_000 }));
  const taking = acquireStateLock({ stateDir, ...fast });
  // Another process took the same stale lease right after us: its write is the last one.
  writeFileSync(lockPath(stateDir), JSON.stringify({ instance: 'other-process', pid: 99, host: 'elsewhere', heartbeatAt: Date.now() }));
  await assert.rejects(taking, (e) => e.code === 'STATE_LOCKED');
});
