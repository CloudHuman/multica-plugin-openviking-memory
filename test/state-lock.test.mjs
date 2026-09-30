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
  assert.ok(Date.now() - t0 < 50, 'no wait for an expired lease');
  lock2.release();
});

test('a lock left by a dead process on this host, or a legacy bare-PID file, is stale', async () => {
  const stateDir = tempStateDir();
  writeFileSync(lockPath(stateDir), JSON.stringify({ instance: 'dead', pid: 2 ** 22 + 12345, host: hostname(), heartbeatAt: Date.now() }));
  const t0 = Date.now();
  const lock = await acquireStateLock({ stateDir, ...fast });
  assert.ok(Date.now() - t0 < 50, 'a provably dead holder is not waited for');
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
