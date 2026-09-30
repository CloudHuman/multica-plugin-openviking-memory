import {
  buildRunMessages, buildCommentMessages, buildChatMessages, buildAppendMessages,
  buildDelegationMessages, commitTags, chunkMessages,
} from './archive.mjs';
import { resolveArchiveScope } from './scopes.mjs';

/**
 * Archive pipeline executor. One job = one record landing in exactly one
 * scope's OV space: provision → session → messages → commit. That is all a job
 * does; watching the commit's extraction happens beside the queue (see
 * extraction-watch.mjs), so one slow LLM extraction never holds up the next
 * archive.
 *
 * Every step is resumable from what OpenViking itself reports, not from
 * checkpoints alone: a request whose response was lost may still have landed,
 * so a retry reads the session back (live message_count, commit_count) and
 * continues from there instead of writing the same messages twice.
 *
 * A job's generation picks its session: generation 0 uses the record's own
 * session id, each re-drive a fresh `-rN` session. OV refuses new commits on a
 * session whose earlier archive failed, and a fresh session is also the only
 * way to extract the same record again (extraction reads live messages, which a
 * commit has already archived away).
 */

export function buildJobMessages(job, cfg) {
  const p = job.payload;
  const settings = { ...cfg, ...(p.settings ?? {}) };
  switch (job.type) {
    case 'archive-run':
      return buildRunMessages({
        taskId: p.refId, agentId: p.agentId ?? p.scope?.agentId, kind: p.kind ?? 'issue', issue: p.issue,
        task: p.task, transcript: p.transcript ?? [], status: p.status, cfg: settings,
      });
    case 'archive-comment':
      return buildCommentMessages({ comment: p.comment, issue: p.issue });
    case 'archive-chat':
      return buildChatMessages({ chatRef: p.refId, turnKey: p.turnKey, agentId: p.scope.agentId, userId: p.scope.userId, messages: p.messages });
    case 'archive-append':
      return buildAppendMessages({ appendId: p.refId, taskId: p.scope.taskId, content: p.content, delivered: p.delivered });
    case 'archive-delegation':
      return buildDelegationMessages({ handoffId: p.refId, fromAgentId: p.scope.fromAgentId, toAgentId: p.scope.toAgentId, content: p.content });
    default: {
      const e = new Error(`unknown archive job type: ${job.type}`);
      e.retryable = false;
      throw e;
    }
  }
}

/** HTTP statuses OV will answer the same way on retry. */
export function markRetryable(err) {
  const status = err?.status;
  if (status && status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status)) err.retryable = false;
  return err;
}

export function makeArchiveHandler({ ov, registry, statusLog, extractions, cfg, log = () => {} }) {
  return async function handleArchiveJob(job) {
    const p = job.payload;
    const scopeKey = p.scopeKey ?? resolveArchiveScope(p.scope);
    const generation = p.generation ?? 0;
    const base = {
      type: job.type, scope: scopeKey, ref: p.refId, workspace: p.workspaceId,
      completeness: p.completeness ?? 'complete', generation,
    };
    try {
      const rec = await registry.ensureForArchive(scopeKey, p.workspaceId);
      const built = buildJobMessages(job, cfg);
      if (!built.messages.length) {
        statusLog.append({ ...base, extraction: 'skipped', skipReason: 'no messages to archive' });
        return;
      }
      const sessionId = generation ? `${built.sessionId}-r${generation}` : built.sessionId;
      job.cp.sessionId = sessionId;

      if (!job.cp.commitTaskId) {
        const session = await readSession(ov, rec.apiKey, sessionId);
        if (!session) {
          await ov.createSession(rec.apiKey, { sessionId, autoCommitPolicy: null });
        }
        if ((session?.commit_count ?? 0) > 0) {
          // The commit landed but its response did not: recover its task.
          const tasks = await ov.listTasks(rec.apiKey, { resourceId: sessionId, taskType: 'session_commit' });
          const latest = [...tasks].sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))[0];
          job.cp.commitTaskId = latest?.task_id ?? null;
          job.cp.archiveUri = latest?.result?.archive_uri ?? null;
        } else {
          const live = Math.max(0, Number(session?.message_count ?? 0));
          for (const chunk of chunkMessages(built.messages.slice(live))) {
            await ov.addMessages(rec.apiKey, sessionId, chunk);
          }
          const commit = await ov.commitSession(rec.apiKey, sessionId, {
            tags: commitTags({ workspaceId: p.workspaceId, scopeKey, kind: job.type, refId: p.refId, agentId: p.agentId ?? p.scope?.agentId }),
          });
          if (commit?.status === 'skipped' || !commit?.task_id) {
            statusLog.append({ ...base, session_id: sessionId, extraction: 'skipped', skipReason: commit?.reason ?? 'commit archived nothing' });
            return;
          }
          job.cp.commitTaskId = commit.task_id;
          job.cp.archiveUri = commit.archive_uri ?? null;
        }
      }

      extractions.watch({
        jobId: job.id, workspaceId: p.workspaceId, scopeKey, sessionId, ref: p.refId, type: job.type,
        taskId: job.cp.commitTaskId, archiveUri: job.cp.archiveUri, generation,
      });
      statusLog.append({ ...base, session_id: sessionId, messages: built.messages.length, extraction: 'pending', extraction_task: job.cp.commitTaskId });
      log(`archived: ${job.type} ${p.refId} -> ${scopeKey} (session ${sessionId}, extraction pending)`);
    } catch (err) {
      throw markRetryable(err);
    }
  };
}

async function readSession(ov, key, sessionId) {
  try {
    return await ov.getSession(key, sessionId);
  } catch (err) {
    if (err.status === 404 || /not.?found/i.test(String(err.code ?? ''))) return null;
    throw err;
  }
}
