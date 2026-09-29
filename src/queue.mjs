import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { nowIso, sleep } from './util.mjs';

/**
 * Durable job queue: append-only journal (queue.ndjson) replayed on boot, so
 * archives survive crashes and restarts ("持久保存、重试和重启恢复").
 *
 * Journal records: {t: 'add'|'update'|'compact-base', job} — a job's latest
 * 'update' wins. Compaction rewrites the file as a compact-base snapshot plus
 * ongoing jobs, keeping growth bounded.
 */
export class JobQueue {
  constructor({ stateDir, handler, maxAttempts = 8, baseDelayMs = 10_000, pollMs = 400, log = () => {}, keepDone = 500 }) {
    this.path = `${stateDir}/queue.ndjson`;
    this.handler = handler;
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
    this.pollMs = pollMs;
    this.log = log;
    this.keepDone = keepDone;
    this.jobs = new Map();
    this.order = [];
    this.running = false;
    this.stopped = false;
    this.wake = null;
    mkdirSync(dirname(this.path), { recursive: true });
    this.#replay();
  }

  #replay() {
    if (!existsSync(this.path)) return;
    const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec?.t === 'compact-base') {
        for (const job of rec.jobs ?? []) {
          this.jobs.set(job.id, job);
        }
        continue;
      }
      const job = rec?.job;
      if (!job?.id) continue;
      if (!this.jobs.has(job.id)) this.order.push(job.id);
      this.jobs.set(job.id, job);
    }
    // Crash recovery: anything mid-flight goes back to queued.
    let recovered = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'running') {
        job.status = 'queued';
        job.next_run_at = 0;
        recovered++;
      }
    }
    if (recovered) this.#persistSnapshot();
    this.log(`queue replayed: ${this.jobs.size} jobs (${recovered} recovered as queued)`);
  }

  #append(rec) {
    appendFileSync(this.path, `${JSON.stringify(rec)}\n`);
  }

  #persistSnapshot() {
    this.#append({ t: 'compact-base', jobs: [...this.jobs.values()] });
    this.#compactFile();
  }

  #compactFile() {
    const done = this.order.filter((id) => this.jobs.get(id)?.status === 'done');
    const excess = Math.max(0, done.length - this.keepDone);
    if (excess > 0) {
      const drop = new Set(done.slice(0, excess));
      for (const id of drop) {
        this.jobs.delete(id);
      }
      this.order = this.order.filter((id) => !drop.has(id));
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ t: 'compact-base', jobs: [...this.jobs.values()] })}\n`);
    renameSync(tmp, this.path);
  }

  enqueue(type, payload, { dedupeKey } = {}) {
    if (dedupeKey) {
      for (const job of this.jobs.values()) {
        if (job.status !== 'done' && job.dedupeKey === dedupeKey) {
          return { id: job.id, reused: true };
        }
      }
    }
    const job = {
      id: randomUUID(),
      type,
      payload,
      cp: {},
      attempts: 0,
      status: 'queued',
      next_run_at: 0,
      dedupeKey: dedupeKey ?? null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    this.#append({ t: 'add', job });
    this.#kick();
    return { id: job.id, reused: false };
  }

  #kick() {
    if (this.wake) {
      this.wake();
      this.wake = null;
    }
  }

  start() {
    this.running = true;
    this.#loop();
  }

  async #loop() {
    while (this.running && !this.stopped) {
      const job = this.#nextDue();
      if (!job) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, this.pollMs);
          t.unref?.();
          this.wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        continue;
      }
      job.status = 'running';
      job.updated_at = nowIso();
      try {
        await this.handler(job);
        job.status = 'done';
        job.last_error = null;
      } catch (err) {
        job.attempts += 1;
        job.last_error = String(err?.message ?? err).slice(0, 500);
        if (job.attempts >= this.maxAttempts) {
          job.status = 'failed';
          this.log(`job ${job.id} (${job.type}) FAILED permanently: ${job.last_error}`);
        } else {
          job.status = 'queued';
          const delay = Math.min(this.baseDelayMs * Math.pow(3, job.attempts - 1), 15 * 60_000);
          job.next_run_at = Date.now() + delay;
          this.log(`job ${job.id} (${job.type}) error (attempt ${job.attempts}): ${job.last_error}; retry in ${Math.round(delay / 1000)}s`);
        }
      }
      job.updated_at = nowIso();
      this.#append({ t: 'update', job });
      if (this.#doneCount() % 200 === 0) this.#persistSnapshot();
    }
  }

  #doneCount() {
    let n = 0;
    for (const job of this.jobs.values()) if (job.status === 'done') n++;
    return n;
  }

  #nextDue() {
    const now = Date.now();
    for (const id of this.order) {
      const job = this.jobs.get(id);
      if (job && job.status === 'queued' && (job.next_run_at ?? 0) <= now) return job;
    }
    return null;
  }

  async stop({ drainMs = 3_000 } = {}) {
    this.stopped = true;
    const deadline = Date.now() + drainMs;
    while (Date.now() < deadline) {
      const busy = [...this.jobs.values()].some((j) => j.status === 'running');
      if (!busy) break;
      await sleep(100);
    }
    this.running = false;
    this.#kick();
    this.#persistSnapshot();
  }

  stats() {
    const s = { queued: 0, running: 0, done: 0, failed: 0 };
    for (const job of this.jobs.values()) s[job.status] = (s[job.status] ?? 0) + 1;
    return s;
  }

  list({ limit = 20 } = {}) {
    return [...this.jobs.values()]
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .slice(0, limit)
      .map(({ id, type, status, attempts, last_error, created_at, updated_at }) => ({
        id, type, status, attempts, last_error, created_at, updated_at,
      }));
  }
}
