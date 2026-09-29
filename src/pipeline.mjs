import { sleep } from './util.mjs';
import {
  buildRunMessages, buildCommentMessages, buildChatMessages, buildAppendMessages,
  buildDelegationMessages, commitTags, chunkMessages,
} from './archive.mjs';
import { resolveArchiveScope } from './scopes.mjs';

/**
 * Archive pipeline executor. One job = one record landing in exactly one
 * scope's OV space: provision → session → messages → commit → extraction
 * watch → (on failure) auto re-extract. Checkpoints (job.cp) make retries
 * resume at the right step instead of duplicating messages.
 */

export function makeArchiveHandler({ ov, registry, statusLog, cfg, log = () => {} }) {
  return async function handleArchiveJob(job) {
    const p = job.payload;
    const scopeKey = p.scopeKey ?? resolveArchiveScope(p.scope);
    const rec = await registry.ensureForArchive(scopeKey, p.workspaceId);

    let built;
    switch (job.type) {
      case 'archive-run':
        built = buildRunMessages({
          taskId: p.refId, agentId: p.scope.agentId, issue: p.issue,
          transcript: p.transcript ?? [], status: p.status, cfg,
        });
        break;
      case 'archive-comment':
        built = buildCommentMessages({ comment: p.comment, issue: p.issue });
        break;
      case 'archive-chat':
        built = buildChatMessages({ chatRef: p.refId, agentId: p.scope.agentId, userId: p.scope.userId, messages: p.messages });
        break;
      case 'archive-append':
        built = buildAppendMessages({ appendId: p.refId, taskId: p.scope.taskId, content: p.content, delivered: p.delivered });
        break;
      case 'archive-delegation':
        built = buildDelegationMessages({ handoffId: p.refId, fromAgentId: p.scope.fromAgentId, toAgentId: p.scope.toAgentId, content: p.content });
        break;
      default:
        throw new Error(`unknown archive job type: ${job.type}`);
    }

    const entry = {
      type: job.type, scope: scopeKey, session_id: built.sessionId, ref: p.refId,
      workspace: p.workspaceId, messages: built.messages.length,
      completeness: p.completeness ?? 'complete',
    };
    job.cp.sessionId = built.sessionId;

    if (!job.cp.sessionCreated) {
      await ov.createSession(rec.apiKey, { sessionId: built.sessionId, autoCommitPolicy: null });
      job.cp.sessionCreated = true;
    }

    if (!job.cp.messagesAdded) {
      for (const chunk of chunkMessages(built.messages)) {
        await ov.addMessages(rec.apiKey, built.sessionId, chunk);
      }
      job.cp.messagesAdded = true;
    }

    if (!job.cp.commitTaskId) {
      const commit = await ov.commitSession(rec.apiKey, built.sessionId, {
        tags: commitTags({ workspaceId: p.workspaceId, scopeKey, kind: job.type, refId: p.refId, agentId: p.scope?.agentId }),
      });
      job.cp.commitTaskId = commit?.task_id ?? null;
      job.cp.archiveUri = commit?.archive_uri ?? null;
      job.cp.commitStatus = commit?.status ?? 'accepted';
      if (commit?.status === 'skipped') {
        // e.g. re-driven job whose session already archived — treat as done.
        entry.extraction = 'skipped';
        entry.skipReason = commit?.reason ?? null;
        statusLog.append(entry);
        return;
      }
    }

    const extraction = await watchExtraction({ ov, key: rec.apiKey, job, cfg, log, sessionId: built.sessionId });
    entry.extraction = extraction.state;
    entry.extraction_task = job.cp.commitTaskId;
    entry.archive_uri = job.cp.archiveUri ?? null;
    if (extraction.state === 'failed') entry.error = extraction.error;
    if (extraction.reextracted) entry.reextracted = true;
    statusLog.append(entry);
    log(`archive done: ${job.type} ${p.refId} -> ${scopeKey} (extraction: ${extraction.state})`);
  };
}

/**
 * Watch the OV background extraction task for a committed session.
 * On failure (e.g. transient 429 swallowed into a terminal marker), re-run
 * extraction via POST /sessions/{id}/extract with backoff before giving up.
 */
async function watchExtraction({ ov, key, job, cfg, log, sessionId }) {
  if (!job.cp.commitTaskId) return { state: 'unknown' };
  const deadline = Date.now() + cfg.extractWatchTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const task = await ov.getTask(key, job.cp.commitTaskId);
      const status = task?.status ?? task?.state;
      if (status === 'succeeded' || status === 'success' || status === 'done' || status === 'completed') {
        return { state: 'done' };
      }
      if (status === 'failed' || status === 'error') {
        return await reextractWithBackoff({ ov, key, sessionId, cfg, log, cause: task?.error ?? 'task failed' });
      }
    } catch (err) {
      log(`extraction watch error for ${job.cp.commitTaskId}: ${err.message}`);
    }
    await sleep(cfg.extractWatchIntervalMs);
  }
  return { state: 'timeout' };
}

async function reextractWithBackoff({ ov, key, sessionId, cfg, log, cause }) {
  for (let attempt = 1; attempt <= cfg.reextractAttempts; attempt++) {
    await sleep(attempt === 1 ? cfg.reextractBaseDelayMs / 4 : cfg.reextractBaseDelayMs * attempt);
    try {
      await ov.extractSession(key, sessionId);
      log(`re-extract triggered (attempt ${attempt}) for ${sessionId}`);
      return { state: 'reextracted', reextracted: true, error: cause };
    } catch (err) {
      log(`re-extract attempt ${attempt} failed: ${err.message}`);
      if (attempt === cfg.reextractAttempts) {
        return { state: 'failed', error: `extraction failed (${cause}); re-extract failed: ${err.message}` };
      }
    }
  }
  return { state: 'failed', error: cause };
}
