import { atomicWriteJson, readJsonIfExists, nowIso } from './util.mjs';

/**
 * Follows each commit's extraction or active-memory reindex to its end, beside
 * the archive queue rather than inside a job.
 *
 * States are reported as the spec asks — archived ≠ extracted ≠ retrievable:
 *   pending   → OV's commit task is still running
 *   done      → the extraction task completed
 *   redriven  → it failed; the record was queued again in a fresh session
 *   failed    → it failed and the re-drive budget is spent (or nothing to re-drive)
 *   timeout   → still unfinished after extractMaxWatchMs
 *
 * Why a re-drive is a new session and not POST /sessions/{id}/extract: extract
 * works on a session's LIVE messages, and a commit has already moved every
 * message into the archive, so it would run over nothing and report success.
 *
 * When OV's task tracker no longer knows a task (restart, TTL), the archive's
 * own markers decide: `.done` written by a finished extraction, `.failed.json`
 * by a failed one.
 */
export class ExtractionWatcher {
  constructor({ ov, registry, queue, statusLog, stateDir, cfg, log = () => {} }) {
    this.ov = ov;
    this.registry = registry;
    this.queue = queue;
    this.statusLog = statusLog;
    this.cfg = cfg;
    this.log = log;
    this.path = `${stateDir}/extractions.json`;
    const data = readJsonIfExists(this.path, { pending: {} });
    this.pending = data.pending ?? {};
    this.timer = null;
    this.ticking = false;
  }

  save() {
    atomicWriteJson(this.path, { pending: this.pending });
  }

  watch({ jobId, workspaceId, scopeKey, sessionId, ref, type, taskId, archiveUri, generation = 0 }) {
    if (!taskId && !archiveUri) throw new Error('extraction watch requires a task or archive URI');
    this.pending[sessionId] = {
      jobId, workspaceId, scopeKey, sessionId, ref, type, taskId, archiveUri, generation,
      startedAt: Date.now(), checks: 0, nextCheckAt: Date.now() + this.cfg.extractPollIntervalMs,
    };
    this.save();
    this.#schedule(this.cfg.extractPollIntervalMs);
  }

  /** Jobs whose payload a re-drive may still need; the queue keeps them. */
  isPinned(jobId) {
    for (const entry of Object.values(this.pending)) if (entry.jobId === jobId) return true;
    return false;
  }

  stats({ workspaceId } = {}) {
    let pending = 0;
    for (const entry of Object.values(this.pending)) if (!workspaceId || entry.workspaceId === workspaceId) pending++;
    return { pending };
  }

  start() {
    this.stopped = false;
    this.#schedule(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  #schedule(delayMs) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick().catch((err) => this.log(`extraction watch tick failed: ${err.message}`)), Math.max(0, delayMs));
    this.timer.unref?.();
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      for (const entry of Object.values(this.pending)) {
        if (entry.nextCheckAt > now) continue;
        await this.#check(entry);
      }
    } finally {
      this.ticking = false;
      const next = Object.values(this.pending).reduce((min, e) => Math.min(min, e.nextCheckAt), Infinity);
      if (Number.isFinite(next)) this.#schedule(Math.max(250, next - Date.now()));
    }
  }

  async #check(entry) {
    const rec = this.registry.get(entry.scopeKey);
    if (!rec) return this.#settle(entry, 'failed', 'scope key missing from registry');
    let state = null;
    let error = null;
    let checkMarkers = !entry.taskId;
    try {
      const task = entry.taskId ? await this.ov.getTask(rec.apiKey, entry.taskId) : null;
      const status = task?.status ?? task?.state;
      if (status === 'completed' || status === 'succeeded' || status === 'done') state = 'done';
      else if (status === 'failed' || status === 'cancelled') {
        state = 'failed';
        error = String(task?.error ?? status).slice(0, 300);
      }
    } catch (err) {
      if (err.status === 404 && entry.type === 'index-memory') {
        // Reindex tasks have no durable archive markers. Rebuilding their
        // vectors/summaries is idempotent, so recover an expired task by retry.
        state = 'failed';
        error = 'reindex task unavailable';
      } else if (err.status === 404) checkMarkers = true;
      else {
        this.log(`extraction watch ${entry.sessionId}: ${err.message}`);
      }
    }
    if (checkMarkers && entry.archiveUri) {
      if (await this.#exists(rec.apiKey, `${entry.archiveUri}/.done`)) state = 'done';
      else if (await this.#exists(rec.apiKey, `${entry.archiveUri}/.failed.json`)) {
        state = 'failed';
        error = 'archive marked .failed.json';
      }
    }

    if (state === 'done') return this.#settle(entry, 'done');
    if (state === 'failed') {
      if (entry.generation < this.cfg.extractMaxRedrives && this.#redrive(entry, error)) {
        return this.#settle(entry, 'redriven', error);
      }
      return this.#settle(entry, 'failed', error);
    }
    if (Date.now() - entry.startedAt > this.cfg.extractMaxWatchMs) return this.#settle(entry, 'timeout');
    entry.checks += 1;
    entry.nextCheckAt = Date.now() + Math.min(
      this.cfg.extractPollIntervalMs * Math.pow(1.5, Math.min(entry.checks, 12)),
      this.cfg.extractPollMaxIntervalMs,
    );
    this.save();
  }

  #redrive(entry, cause) {
    const job = this.queue.requeue(entry.jobId, {
      delayMs: this.cfg.extractRedriveDelayMs,
      reason: `extraction failed (${cause ?? 'unknown'})`,
    });
    if (job) this.log(`extraction failed for ${entry.sessionId}; re-driving as generation ${job.payload.generation}`);
    return Boolean(job);
  }

  async #exists(key, uri) {
    try {
      await this.ov.readContent(key, uri, { limit: 1 });
      return true;
    } catch {
      return false;
    }
  }

  #settle(entry, state, error = null) {
    delete this.pending[entry.sessionId];
    this.save();
    this.statusLog.append({
      type: 'extraction', ref: entry.ref, record: entry.type, scope: entry.scopeKey, workspace: entry.workspaceId,
      session_id: entry.sessionId, extraction_task: entry.taskId, generation: entry.generation,
      extraction: state, ...(error ? { error } : {}), settled_at: nowIso(),
    });
    this.log(`extraction ${state}: ${entry.sessionId}${error ? ` (${error})` : ''}`);
  }
}
