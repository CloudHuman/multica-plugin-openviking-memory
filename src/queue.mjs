import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { nowIso, sleep } from './util.mjs';
import { failureDiagnostic, redactError } from './diagnostics.mjs';

/**
 * Durable job queue: append-only journal (queue.ndjson) replayed on boot, so
 * archives survive crashes and restarts ("持久保存、重试和重启恢复").
 *
 * Journal records: {t: 'add'|'update', job} and {t: 'compact-base', jobs} — a
 * job's latest record wins. Compaction rewrites the file as one compact-base
 * snapshot, keeping growth bounded.
 *
 * One job per dedupeKey: a record that failed, or a partial archive upgraded by a
 * richer redelivery, is re-run as the SAME job with a new generation (a fresh OV
 * session), never as a second job racing the first.
 */
export class JobQueue {
  constructor({ stateDir, handler, maxAttempts = 8, baseDelayMs = 10_000, pollMs = 400, log = () => {}, keepDone = 500, isPinned = () => false }) {
    this.path = `${stateDir}/queue.ndjson`;
    this.handler = handler;
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
    this.pollMs = pollMs;
    this.log = log;
    this.keepDone = keepDone;
    this.isPinned = isPinned;
    this.jobs = new Map();
    this.order = [];
    this.running = false;
    this.stopped = false;
    this.wake = null;
    this.current = null;
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
        for (const job of rec.jobs ?? []) this.jobs.set(job.id, job);
        continue;
      }
      const job = rec?.job;
      if (!job?.id) continue;
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
    // The runner only scans `order`; compact-base records restore job state
    // without it, so rebuild it from the map or replayed jobs are invisible.
    this.order = [...this.jobs.values()]
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .map((j) => j.id);
    if (recovered) this.#persistSnapshot();
    this.log(`queue replayed: ${this.jobs.size} jobs (${recovered} recovered as queued)`);
  }

  #append(rec) {
    appendFileSync(this.path, `${JSON.stringify(rec)}\n`);
  }

  #persistSnapshot() {
    this.#compactFile();
  }

  #compactFile() {
    // Only done jobs are dropped, oldest first — and never one whose extraction
    // is still being watched, because a re-drive needs its payload.
    const done = this.order.filter((id) => this.jobs.get(id)?.status === 'done' && !this.isPinned(id));
    const excess = Math.max(0, done.length - this.keepDone);
    if (excess > 0) {
      const drop = new Set(done.slice(0, excess));
      for (const id of drop) this.jobs.delete(id);
      this.order = this.order.filter((id) => !drop.has(id));
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ t: 'compact-base', jobs: [...this.jobs.values()] })}\n`);
    renameSync(tmp, this.path);
  }

  findByDedupeKey(dedupeKey) {
    for (const job of this.jobs.values()) if (job.dedupeKey === dedupeKey) return job;
    return null;
  }

  enqueue(type, payload, { dedupeKey } = {}) {
    if (dedupeKey) {
      const job = this.findByDedupeKey(dedupeKey);
      if (job) {
        if (job.status === 'failed') {
          this.requeue(job.id, { payload, reason: 'redelivered after failure' });
          return { id: job.id, reused: false, requeued: true };
        }
        // A settled PARTIAL archive upgraded by a richer redelivery (e.g. the
        // transcript was unavailable at first and later re-sent complete).
        const wasPartial = String(job.payload?.completeness ?? '').startsWith('partial');
        if (job.status === 'done' && wasPartial && payload?.completeness === 'complete') {
          this.requeue(job.id, { payload, reason: 'upgraded partial → complete' });
          return { id: job.id, reused: false, upgraded: true };
        }
        return { id: job.id, reused: true };
      }
    }
    const job = {
      id: randomUUID(),
      type,
      payload: { generation: 0, ...payload },
      cp: {},
      attempts: 0,
      status: 'queued',
      next_run_at: 0,
      dedupeKey: dedupeKey ?? null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.#append({ t: 'add', job });
    // A failed journal write must not leave a volatile dedupe entry that a
    // redelivery mistakes for durable acceptance.
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    this.#kick();
    return { id: job.id, reused: false };
  }

  /**
   * Run a job again as its next generation: a fresh OV session, reset
   * checkpoints and attempts. Used for redeliveries and extraction re-drives.
   * A running job is not touched (its outcome is still pending). Automatic
   * re-drives are counted apart (autoRedrives): a redelivery, a manual redrive
   * or a reindex requested by memory-remember starts that count again.
   */
  requeue(id, { payload, delayMs = 0, reason = '', autoRedrive = false } = {}) {
    const job = this.jobs.get(id);
    if (!job || job.status === 'running' || job.status === 'queued') return null;
    const generation = (job.payload?.generation ?? 0) + 1;
    const autoRedrives = autoRedrive ? (job.payload?.autoRedrives ?? 0) + 1 : 0;
    const updated = {
      ...job, payload: { ...(payload ?? job.payload), generation, autoRedrives }, cp: {}, attempts: 0,
      status: 'queued', next_run_at: Date.now() + delayMs,
      last_error: reason ? `requeued: ${reason}` : null, updated_at: nowIso(),
      last_error_diagnostic: null,
    };
    this.#append({ t: 'update', job: updated });
    Object.assign(job, updated);
    this.#kick();
    return job;
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
      this.current = job.id;
      try {
        await this.handler(job);
        job.status = 'done';
        job.last_error = null;
        job.last_error_diagnostic = null;
      } catch (err) {
        job.attempts += 1;
        job.last_error = redactError(err?.message ?? err).slice(0, 500);
        job.last_error_diagnostic = failureDiagnostic(err, { source: 'archive-job' });
        // A request OV refuses as invalid will be refused again: fail now
        // instead of retrying for hours.
        if (err?.retryable === false || job.attempts >= this.maxAttempts) {
          job.status = 'failed';
          this.log(`job ${job.id} (${job.type}) FAILED${err?.retryable === false ? ' (not retryable)' : ''}: ${job.last_error}`);
        } else {
          job.status = 'queued';
          const delay = Math.min(this.baseDelayMs * Math.pow(3, job.attempts - 1), 15 * 60_000);
          job.next_run_at = Date.now() + delay;
          this.log(`job ${job.id} (${job.type}) error (attempt ${job.attempts}): ${job.last_error}; retry in ${Math.round(delay / 1000)}s`);
        }
      } finally {
        this.current = null;
      }
      job.updated_at = nowIso();
      this.#append({ t: 'update', job });
      this.#maybeCompact();
    }
  }

  #appendsSinceCompact = 0;

  #maybeCompact() {
    this.#appendsSinceCompact++;
    if (this.#appendsSinceCompact >= 200) {
      this.#appendsSinceCompact = 0;
      this.#compactFile();
    }
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
    while (Date.now() < deadline && this.current) await sleep(100);
    this.running = false;
    this.#kick();
    this.#persistSnapshot();
  }

  stats({ workspaceId } = {}) {
    const s = { queued: 0, running: 0, done: 0, failed: 0 };
    for (const job of this.jobs.values()) {
      if (workspaceId && job.payload?.workspaceId !== workspaceId) continue;
      s[job.status] = (s[job.status] ?? 0) + 1;
    }
    return s;
  }

  list({ limit = 20, workspaceId } = {}) {
    return [...this.jobs.values()]
      .filter((job) => !workspaceId || job.payload?.workspaceId === workspaceId)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .slice(0, limit)
      .map(({ id, type, status, attempts, last_error, created_at, updated_at, payload }) => ({
        id, type, status, attempts, last_error, created_at, updated_at,
        workspace: payload?.workspaceId, ref: payload?.refId, generation: payload?.generation ?? 0,
      }));
  }
}
