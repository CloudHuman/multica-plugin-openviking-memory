import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { sleep } from './util.mjs';

/**
 * Single-writer lease on the state directory. Two services sharing one state
 * dir corrupt each other's queue journal, so the second one must refuse.
 *
 * A PID alone cannot decide this: in containers every service is PID 1 in its
 * own namespace, so "is PID 1 alive?" is always yes and always about oneself.
 * The lease is a lock file the holder refreshes every heartbeatMs; another
 * holder is alive exactly when that heartbeat keeps moving.
 *
 *   - no lock, or a heartbeat older than ttlMs            → take it
 *   - same host, different PID, process gone              → stale → take it
 *   - otherwise watch the lock for two heartbeat windows: if it moved, another
 *     writer is alive → refuse; if not, it is stale → take it. This covers
 *     "same host, same PID" too, which is either our own previous run (a
 *     container restart) or a twin container sharing the hostname
 *     (network_mode: host, both PID 1) — only the heartbeat tells them apart.
 */
export async function acquireStateLock({ stateDir, ttlMs = 15_000, heartbeatMs = 5_000, log = () => {}, onLost = () => {} }) {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, 'service.lock');
  const me = { instance: randomUUID(), pid: process.pid, host: hostname(), heartbeatAt: Date.now() };

  const fresh = (lock) => Boolean(lock) && Date.now() - Number(lock.heartbeatAt ?? 0) < ttlMs;
  const held = readLock(path);
  if (fresh(held)) {
    const provablyDead = held.host === me.host && Number(held.pid) !== process.pid && !processAlive(Number(held.pid));
    if (!provablyDead) {
      await sleep(heartbeatMs * 2 + 250);
      const again = readLock(path);
      if (again && again.instance === held.instance && Number(again.heartbeatAt) !== Number(held.heartbeatAt)) throw locked(held);
      // A third writer took the lease while we watched.
      if (again && again.instance !== held.instance && fresh(again)) throw locked(again);
    }
    log(`taking over state lock from ${held.host}/${held.pid} (its heartbeat stopped)`);
  }

  writeLock(path, me);
  const timer = setInterval(() => {
    // Someone else holds the lease now: stop writing rather than keep two
    // writers alive. Whoever took it over is the one that continues.
    const current = readLock(path);
    if (current && current.instance !== me.instance) {
      clearInterval(timer);
      log(`state lock taken over by ${current.host}/${current.pid}; this instance must stop writing`);
      onLost(current);
      return;
    }
    me.heartbeatAt = Date.now();
    try { writeLock(path, me); } catch { /* next beat retries */ }
  }, heartbeatMs);
  timer.unref?.();

  return {
    release() {
      clearInterval(timer);
      try {
        if (readLock(path)?.instance === me.instance) unlinkSync(path);
      } catch { /* already gone */ }
    },
  };
}

function readLock(path) {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    // Pre-lease lock files held a bare PID; treat them as stale leases.
    if (/^\d+$/.test(raw)) return { instance: 'legacy', pid: Number(raw), host: hostname(), heartbeatAt: 0 };
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeLock(path, me) {
  const tmp = `${path}.${me.instance}.tmp`;
  writeFileSync(tmp, JSON.stringify(me));
  renameSync(tmp, path);
}

function processAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function locked(held) {
  const e = new Error(`state dir is locked by a live writer (${held.host}/${held.pid}); refusing to start a second writer`);
  e.code = 'STATE_LOCKED';
  return e;
}
