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
 * archive. Active-memory indexing uses the same durable queue and watcher:
 * submit a recursive reindex, then track it without waiting for model work.
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
      return buildCommentMessages({ comment: p.comment, issue: p.issue, cfg: settings });
    case 'archive-chat':
      return buildChatMessages({ chatRef: p.refId, turnKey: p.turnKey, agentId: p.scope.agentId, userId: p.scope.userId, messages: p.messages, cfg: settings });
    case 'archive-append':
      return buildAppendMessages({ appendId: p.refId, taskId: p.scope.taskId, content: p.content, delivered: p.delivered, cfg: settings });
    case 'archive-delegation':
      return buildDelegationMessages({ handoffId: p.refId, fromAgentId: p.scope.fromAgentId, toAgentId: p.scope.toAgentId, content: p.content });
    case 'consolidate':
      return { sessionId: p.sessionId, messages: p.messages };
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

export function makeArchiveHandler({ ov, registry, statusLog, extractions, cfg, memoryRules = null, log = () => {} }) {
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
      if (job.type === 'index-memory') {
        if (!job.cp.indexTaskId) {
          const indexed = await ov.reindex(rec.apiKey, p.uri, { mode: 'semantic_and_vectors', recursive: true, wait: false });
          if (!indexed?.task_id) throw new Error('reindex returned no background task ID');
          job.cp.indexTaskId = indexed.task_id;
        }
        const watchId = `memory-index-${job.id}-r${generation}`;
        extractions.watch({
          jobId: job.id, workspaceId: p.workspaceId, scopeKey, sessionId: watchId, ref: p.refId,
          type: job.type, taskId: job.cp.indexTaskId, generation, autoRedrives: p.autoRedrives ?? 0,
        });
        statusLog.append({ ...base, extraction: 'pending', extraction_task: job.cp.indexTaskId });
        return;
      }
      const built = buildJobMessages(job, cfg);
      if (!built.messages.length) {
        statusLog.append({ ...base, extraction: 'skipped', skipReason: 'no messages to archive' });
        return;
      }
      const sessionId = generation ? `${built.sessionId}-r${generation}` : built.sessionId;
      job.cp.sessionId = sessionId;

      if (!job.cp.commitTaskId && !job.cp.archiveUri) {
        const session = await readSession(ov, rec.apiKey, sessionId);
        if (!session) {
          await ov.createSession(rec.apiKey, { sessionId, autoCommitPolicy: null });
        }
        if ((session?.commit_count ?? 0) > 0) {
          // Tasks expire, but the numbered archive and its markers persist.
          const tasks = await ov.listTasks(rec.apiKey, { resourceId: sessionId, taskType: 'session_commit' });
          const latest = [...tasks].sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))[0];
          job.cp.commitTaskId = latest?.task_id ?? null;
          job.cp.archiveUri = latest?.result?.archive_uri ??
            `viking://user/${rec.userId}/sessions/${sessionId}/history/archive_${String(session.commit_count).padStart(3, '0')}`;
        } else {
          // The workspace's extraction rules land before its records are committed.
          await memoryRules?.settled(p.workspaceId);
          const live = Math.max(0, Number(session?.message_count ?? 0));
          // Deterministic for a given record and config, so a resumed job
          // continues the same sequence from the session's live count.
          const plan = planExtractionBatches(built.messages, cfg);
          for (const chunk of chunkMessages(plan.messages.slice(live))) {
            await ov.addMessages(rec.apiKey, sessionId, chunk);
          }
          job.cp.batches = plan.batches > 1 && await limitExtractionBatches(ov, rec.apiKey, sessionId, cfg, log) ? plan.batches : 1;
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
        taskId: job.cp.commitTaskId, archiveUri: job.cp.archiveUri, generation, autoRedrives: p.autoRedrives ?? 0,
      });
      statusLog.append({
        ...base, session_id: sessionId, messages: built.messages.length, extraction: 'pending', extraction_task: job.cp.commitTaskId,
        ...(job.cp.batches > 1 ? { extraction_batches: job.cp.batches } : {}),
      });
      log(`archived: ${job.type} ${p.refId} -> ${scopeKey} (session ${sessionId}, extraction pending)`);
    } catch (err) {
      throw markRetryable(err);
    }
  };
}

/**
 * Extraction batches. OpenViking splits one commit's extraction into batches
 * when the session carries an auto-commit policy, and it writes memories only
 * from a batch that holds a user message: a batch of agent steps alone extracts
 * nothing. Measured with real models on a 2,409-message run, plain batches kept
 * 1 of 8 planted facts and one extraction kept 8 of 8
 * (reports/full-transcript-2026-10-13.md).
 *
 * So a record is batched only when it is too large for one extraction
 * (cfg.extractBatchTokens, in OpenViking's own token estimate), and then a
 * copy of its opening context message starts every batch. A record that does
 * not open with such a message (a member chat) is never batched: repeating a
 * member's words would put them in the record twice.
 */
export function planExtractionBatches(messages, cfg) {
  const limit = batchLimit(cfg);
  const tokens = messages.map(messageTokens);
  const first = messages[0];
  const anchored = first?.role === 'user' && first.message_kind === 'user_query' && !first.peer_id && typeof first.content === 'string';
  if (!anchored || tokens.reduce((a, b) => a + b, 0) <= limit) return { messages, batches: 1 };
  // Each segment (a context message and what follows it) stays well inside one
  // batch, so OpenViking packs whole segments and never cuts one off its context.
  const budget = Math.floor(limit * 0.8);
  const out = [first];
  let used = tokens[0];
  let segment = 1;
  for (let i = 1; i < messages.length; i++) {
    if (used + tokens[i] > budget) {
      segment += 1;
      const context = { ...first, content: `${first.content}\n\n（同一次运行的执行记录，第 ${segment} 段）` };
      out.push(context);
      used = messageTokens(context);
    }
    out.push(messages[i]);
    used += tokens[i];
  }
  return { messages: out, batches: segment };
}

// OpenViking clamps a session's token threshold to 1,000,000; segments are cut
// to the same limit it will batch by.
const batchLimit = (cfg) => Math.min(cfg.extractBatchTokens ?? 300_000, 1_000_000);

/** OpenViking's estimate for one message: the text it puts in the prompt, CJK at 1.5 tokens a character. */
export function messageTokens(m) {
  const text = [m.content ?? ''];
  for (const p of m.parts ?? []) {
    if (p.type === 'text') text.push(p.text ?? '');
    else if (p.type === 'tool') text.push(p.tool_id ?? '', p.tool_name ?? '', p.tool_input ? JSON.stringify(p.tool_input) : '', p.tool_output ?? '');
    else text.push(JSON.stringify(p));
  }
  return estimateTokens(text.join(''));
}

function estimateTokens(text) {
  let units = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x1100) units += 1;
    else if (c > 0xffff) units += 8;
    else if ((c >= 0x4e00 && c <= 0x9fff) || c <= 0x11ff || (c >= 0x3000 && c <= 0x30ff) || (c >= 0x3130 && c <= 0x318f)
      || (c >= 0x31f0 && c <= 0x31ff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xac00 && c <= 0xd7af)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) units += 6;
    else units += 1;
  }
  return Math.ceil(units / 4);
}

/**
 * Set the batch limit as the session's auto-commit policy, after the last write
 * and before the one commit (a policy is only checked on writes, so this
 * triggers no commit of its own). Batches are bounded by tokens alone. An
 * OpenViking without the session config endpoint extracts the record in one go.
 */
export async function limitExtractionBatches(ov, key, sessionId, cfg, log = () => {}) {
  try {
    await ov.updateSessionConfig(key, sessionId, {
      autoCommitPolicy: { message_count_threshold: 0, pending_token_threshold: batchLimit(cfg) },
    });
    return true;
  } catch (err) {
    if (err?.status === 404 || err?.status === 405) {
      log(`session ${sessionId}: OpenViking has no session config endpoint; extracting the record in one batch`);
      return false;
    }
    throw err;
  }
}

async function readSession(ov, key, sessionId) {
  try {
    return await ov.getSession(key, sessionId);
  } catch (err) {
    if (err.status === 404 || /not.?found/i.test(String(err.code ?? ''))) return null;
    throw err;
  }
}
