import { atomicWriteJson, readJsonIfExists, nowIso } from './util.mjs';
import { failureDiagnostic, redactError } from './diagnostics.mjs';

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

  watch({ jobId, workspaceId, scopeKey, sessionId, ref, type, taskId, archiveUri, generation = 0, autoRedrives = 0 }) {
    if (!taskId && !archiveUri) throw new Error('extraction watch requires a task or archive URI');
    this.pending[sessionId] = {
      jobId, workspaceId, scopeKey, sessionId, ref, type, taskId, archiveUri, generation, autoRedrives,
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
    let pollingErrors = 0;
    for (const entry of Object.values(this.pending)) {
      if (workspaceId && entry.workspaceId !== workspaceId) continue;
      pending++;
      if (entry.last_poll_error) pollingErrors++;
    }
    return { pending, polling_errors: pollingErrors };
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
    let diagnostic = null;
    let pollFailed = false;
    let checkMarkers = !entry.taskId;
    try {
      const task = entry.taskId ? await this.ov.getTask(rec.apiKey, entry.taskId) : null;
      const status = task?.status ?? task?.state;
      if (status === 'completed' || status === 'succeeded' || status === 'done') state = 'done';
      else if (status === 'failed' || status === 'cancelled') {
        state = 'failed';
        error = redactError(task?.error?.message ?? task?.error ?? status, [rec.apiKey]).slice(0, 300);
        diagnostic = failureDiagnostic(task?.error?.message ?? task?.error ?? status, { source: 'extraction-task' });
      }
    } catch (err) {
      if (err.status === 404 && entry.type === 'index-memory') {
        // Reindex tasks have no durable archive markers. Rebuilding their
        // vectors/summaries is idempotent, so recover an expired task by retry.
        state = 'failed';
        error = 'reindex task unavailable';
        diagnostic = failureDiagnostic(err, { source: 'task-tracker' });
      } else if (err.status === 404) checkMarkers = true;
      else {
        pollFailed = true;
        this.#pollError(entry, err, rec.apiKey);
      }
    }
    if (checkMarkers && entry.archiveUri) {
      try {
        if (await this.#readMarker(rec.apiKey, `${entry.archiveUri}/.done`, 1)) state = 'done';
        else {
          const failed = await this.#readMarker(rec.apiKey, `${entry.archiveUri}/.failed.json`, 100);
          if (failed) {
            state = 'failed';
            let marker = null;
            try { marker = JSON.parse(failed.content); } catch { /* older/unreadable marker still proves failure */ }
            const cause = marker?.error?.message ?? marker?.error ?? 'archive marked .failed.json';
            error = redactError(cause, [rec.apiKey]).slice(0, 300);
            diagnostic = failureDiagnostic(cause, { source: 'archive-marker' });
            if (typeof marker?.stage === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(marker.stage)) diagnostic.stage = marker.stage;
          }
        }
      } catch (err) {
        // A refused/unavailable marker read does not prove absence or failure.
        pollFailed = true;
        this.#pollError(entry, err, rec.apiKey);
      }
    }
    if (!pollFailed) {
      delete entry.last_poll_error;
      delete entry.last_poll_diagnostic;
    }

    if (state === 'done') return this.#settle(entry, 'done');
    if (state === 'failed') {
      // Watches saved before autoRedrives existed count by generation, as they used to.
      if ((entry.autoRedrives ?? entry.generation) < this.cfg.extractMaxRedrives && this.#redrive(entry, error)) {
        return this.#settle(entry, 'redriven', error, diagnostic);
      }
      return this.#settle(entry, 'failed', error, diagnostic);
    }
    if (Date.now() - entry.startedAt > this.cfg.extractMaxWatchMs) {
      return this.#settle(entry, 'timeout', entry.last_poll_error, entry.last_poll_diagnostic);
    }
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
      autoRedrive: true,
    });
    if (job) this.log(`extraction failed for ${entry.sessionId}; re-driving as generation ${job.payload.generation}`);
    return Boolean(job);
  }

  #pollError(entry, err, key) {
    const message = redactError(err.message ?? err, [key]).slice(0, 300);
    const diagnostic = failureDiagnostic(err, { source: 'extraction-poll' });
    if (entry.last_poll_error !== message) {
      this.log(`extraction watch ${entry.sessionId}: ${message}`);
      this.statusLog.append({
        type: 'extraction-poll-error', ref: entry.ref, scope: entry.scopeKey, workspace: entry.workspaceId,
        session_id: entry.sessionId, error: message, error_diagnostic: diagnostic,
      });
    }
    entry.last_poll_error = message;
    entry.last_poll_diagnostic = diagnostic;
  }

  async #readMarker(key, uri, limit) {
    try {
      return await this.ov.readContent(key, uri, { limit });
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  #settle(entry, state, error = null, diagnostic = null) {
    delete this.pending[entry.sessionId];
    this.save();
    this.statusLog.append({
      type: 'extraction', ref: entry.ref, record: entry.type, scope: entry.scopeKey, workspace: entry.workspaceId,
      session_id: entry.sessionId, extraction_task: entry.taskId, generation: entry.generation,
      extraction: state, ...(error ? { error } : {}), ...(diagnostic ? { error_diagnostic: diagnostic } : {}), settled_at: nowIso(),
    });
    this.log(`extraction ${state}: ${entry.sessionId}${error ? ` (${error})` : ''}`);
  }
}
