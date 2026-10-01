#!/usr/bin/env node
/**
 * OpenViking Agent Memory — Multica plugin backend service.
 *
 * Surface:
 *   POST /hooks/memory-archive    multica event hook (task.completed/failed, comment.created), HMAC-signed
 *   POST /hooks/memory-recall     multica agent tool (scoped multi-space recall)
 *   POST /hooks/memory-remember   multica agent tool (active write into agent-public memory)
 *   POST /hooks/memory-status     multica agent tool (service + archive processing status)
 *   POST /hooks/ov-*              multica agent tools (native OpenViking tools, own space only)
 *   POST /internal/recall         companion API: scoped recall for claim-time injection
 *   POST /internal/events         companion API: chat / append / automation / delegation events
 *   GET  /healthz                 liveness + dependency snapshot (no auth)
 *   GET  /admin/status            operator status dump (bearer OVMEM_PLUGIN_TOKEN)
 *   POST /admin/test-recall       operator recall probe
 *   POST /admin/consolidate       shared-memory promotion
 *   POST /admin/redrive           run an archive job again in a fresh session
 *
 * Every hook delivery is authenticated against the installation it names and
 * the workspace that installation is bound to (installations.mjs). After that,
 * agent tools return failures as readable 200 results. Archive events are ACKed
 * only after durable enqueue (or an intentional skip); failures return 503 so
 * multica can redeliver them.
 *
 * Everything long-running goes through the durable queue; hook handlers ACK
 * fast after fetching callback ingredients while the callback token is alive.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { loadConfig, validateStartupConfig, mergeCallConfig, archiveSettings } from './config.mjs';
import { OvClient, isAlreadyExists } from './ov-client.mjs';
import { MulticaClient, isNotFound } from './multica-client.mjs';
import { ScopeRegistry, resolveReadScopes, resolveArchiveScope, scopeKey, runScopes } from './scopes.mjs';
import { recallFromScopes, renderRecallBlock } from './recall.mjs';
import { buildJobMessages } from './pipeline.mjs';
import { createArchiveProcessing } from './processing.mjs';
import { Ledger, ArchiveStatusLog } from './ledger.mjs';
import { InstallationRegistry } from './installations.mjs';
import { buildRememberFile } from './archive.mjs';
import { makeOvToolHandler } from './ov-facade.mjs';
import { consolidateShared } from './consolidate.mjs';
import { acquireStateLock } from './state-lock.mjs';
import { safeEqual, shortHash, cap } from './util.mjs';

const log = (...args) => console.log(new Date().toISOString(), ...args);

export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();

export function createApp({ cfg, ov, registry, queue, ledger, statusLog, installations, extractions, fetchImpl } = {}) {
  installations ??= new InstallationRegistry({ stateDir: cfg.stateDir, cfg, fetchImpl, log });
  extractions ??= { stats: () => ({ pending: 0 }), watch: () => {}, isPinned: () => false };
  // Per installation: did GET /v1/tasks/{id} answer? (true / false / unknown)
  const taskApi = new Map();
  const deps = { cfg, ov, registry, queue, ledger, statusLog, installations, extractions, fetchImpl, taskApi };
  return {
    ...deps,
    handlers: {
      'memory-archive': makeMemoryArchiveHandler(deps),
      'memory-recall': makeMemoryRecallHandler(deps),
      'memory-remember': makeMemoryRememberHandler(deps),
      'memory-status': makeMemoryStatusHandler(deps),
      // ov-<native-tool> facade hooks all share one handler
      ov: makeOvToolHandler(deps),
    },
    handleInternalRecall: makeInternalRecallHandler(deps),
    handleInternalEvent: makeInternalEventHandler(deps),
    handleAdminStatus: makeAdminStatusHandler(deps),
    handleAdminTestRecall: makeAdminTestRecallHandler(deps),
    handleAdminConsolidate: makeAdminConsolidateHandler({ ...deps, log }),
    handleAdminRedrive: makeAdminRedriveHandler(deps),
  };
}

function toolError(message, code = 'invalid_request') {
  const e = new Error(message);
  e.code = code;
  return e;
}

const errText = (err) => `${err?.status ?? err?.code ?? ''} ${String(err?.message ?? err)}`.trim().slice(0, 240);

function callbackClient({ cfg, fetchImpl }, ctx, body, budgetMs) {
  return new MulticaClient({
    callbackUrl: ctx.callbackBase,
    callbackToken: body.callback_token,
    timeoutMs: cfg.callbackTimeoutMs,
    fetchImpl,
    deadline: Date.now() + budgetMs,
  });
}

// ---------------------------------------------------------------------------
// multica event hook: memory-archive
// ---------------------------------------------------------------------------

export function makeMemoryArchiveHandler(deps) {
  const { cfg, ledger, statusLog } = deps;
  return async function memoryArchive(body, ctx) {
    const eventType = body.event_type ?? '';
    const input = body.input ?? {};
    const ws = ctx.workspaceId;
    // multica mints a new invocation id per delivery attempt, so the ledger only
    // absorbs byte-identical redeliveries; the queue's dedupeKey does the rest.
    const ledgerKey = `inv:${body.invocation_id ?? shortHash(JSON.stringify(body))}`;
    if (ledger.has(ledgerKey)) return { status: 'duplicate', ledger: ledgerKey };

    const settings = archiveSettings(mergeCallConfig(cfg, body.config));
    const mc = callbackClient(deps, ctx, body, cfg.archiveFetchBudgetMs);
    const skip = (reason, ref) => {
      statusLog.append({ type: 'skipped', event: eventType, ref, workspace: ws, reason });
      return { status: 'skipped', reason };
    };

    let outcome;
    if (eventType === 'task.completed' || eventType === 'task.failed') {
      outcome = await archiveTaskEvent({ ...deps, body, input, ws, ctx, mc, settings, eventType, skip });
    } else if (eventType === 'comment.created') {
      outcome = await archiveCommentEvent({ ...deps, body, input, ws, ctx, mc, settings, skip });
    } else {
      outcome = skip(`event ${eventType || '(none)'} is not archived`);
    }
    ledger.add(ledgerKey);
    return outcome;
  };
}

async function archiveTaskEvent({ cfg, queue, statusLog, taskApi, body, input, ws, ctx, mc, settings, eventType, skip, prefetchedTask }) {
  const taskId = input.task_id || body.task_id;
  if (!taskId) return skip('task event without task_id');
  if (eventType === 'task.failed' && input.retry_pending === true) {
    return skip('intermediate failure: multica is retrying this run', taskId);
  }
  const status = eventType === 'task.failed' ? 'failed' : (input.status || 'completed');
  const partial = [];

  // 1. The run itself. Multica builds with the task read API describe it;
  //    stock builds answer 404 and only the event payload is known.
  let task = prefetchedTask ?? null;
  try {
    task ??= await mc.getTask(taskId);
    taskApi.set(ctx.installationId, true);
  } catch (err) {
    if (isNotFound(err)) taskApi.set(ctx.installationId, false);
    else partial.push(`run details unavailable (${errText(err)})`);
  }
  const agentId = task?.agent_id || input.agent_id || null;
  const issueId = task?.issue_id || input.issue_id || null;
  const kind = task?.kind ?? (issueId ? 'issue' : null);
  if (!kind || !agentId) {
    return skip(taskApi.get(ctx.installationId) === false
      ? 'run is not tied to an issue and multica has no task API (GET /v1/tasks/{id}) to describe it'
      : 'run kind unknown', taskId);
  }
  const scopes = runScopes({ workspaceId: ws, task: task ?? { id: taskId, agent_id: agentId, kind, issue_id: issueId } });
  if (!scopes) return skip(`run is missing the link its kind (${kind}) needs`, taskId);

  // 2. What happened in it.
  let transcript = [];
  if (taskApi.get(ctx.installationId) !== false) {
    try {
      const r = await mc.listTaskMessages(taskId, { maxMessages: cfg.transcriptMaxMessages });
      transcript = r.messages;
      if (!r.complete) partial.push('transcript truncated');
    } catch (err) {
      partial.push(isNotFound(err) ? 'multica has no transcript API' : `transcript unavailable (${errText(err)})`);
    }
  } else {
    partial.push('multica has no transcript API (GET /v1/tasks/{id}/messages)');
  }

  // 3. The issue it worked on.
  let issue = null;
  if (kind === 'issue') {
    try {
      issue = await mc.getIssue(issueId);
    } catch (err) {
      issue = { id: issueId, identifier: '', title: '', description: '' };
      partial.push(`issue unavailable (${errText(err)})`);
    }
  }

  const evidence = transcript.some((m) => ['text', 'tool_use', 'tool_result', 'error'].includes(m?.type)) || (task?.input?.length ?? 0) > 0;
  const completeness = partial.length ? `partial: ${partial.join('; ')}` : 'complete';
  if (!evidence) {
    // An archive of nothing but "agent X ran with status Y" distils into noise
    // memories; the agent's visible comments are archived on their own.
    return skip(`nothing to archive for this run (${completeness})`, taskId);
  }

  const payload = {
    workspaceId: ws,
    installationId: ctx.installationId,
    refId: taskId,
    kind,
    agentId,
    status,
    task: task ? pickTask(task) : { id: taskId, agent_id: agentId, kind, issue_id: issueId },
    issue: issue ? { id: issue.id, identifier: issue.identifier ?? '', title: issue.title ?? '', description: issue.description ?? '' } : null,
    transcript,
    settings,
    scopeKey: scopes.archiveScope,
    completeness,
  };
  const enq = queue.enqueue('archive-run', payload, { dedupeKey: `archive-run:${ws}:${taskId}` });
  // multica retries a delivery under a new invocation id: same record, same job.
  // A delegated run also records its handoff in the channel between the two agents.
  const handoff = task?.input?.find((i) => i.source === 'handoff' && i.content);
  if (scopes.delegationScope && handoff) {
    queue.enqueue('archive-delegation', {
      workspaceId: ws, installationId: ctx.installationId, refId: taskId, content: handoff.content,
      scope: { kind: 'delegation', workspaceId: ws, fromAgentId: task.delegated_from_agent_id, toAgentId: agentId },
      scopeKey: scopes.delegationScope, completeness: 'complete',
    }, { dedupeKey: `archive-deleg:${ws}:${taskId}` });
  }
  if (enq.reused) return { status: 'duplicate', job: enq.id };
  statusLog.append({ type: 'accepted', event: eventType, ref: taskId, kind, scope: scopes.archiveScope, job: enq.id, completeness, workspace: ws });
  return { status: 'queued', job: enq.id, kind, scope: scopes.archiveScope, completeness };
}

function pickTask(task) {
  return {
    id: task.id,
    kind: task.kind,
    agent_id: task.agent_id,
    issue_id: task.issue_id ?? null,
    chat_session_id: task.chat_session_id ?? null,
    chat_user_id: task.chat_user_id ?? null,
    autopilot_id: task.autopilot_id ?? null,
    trigger_summary: task.trigger_summary ?? null,
    delegated_from_agent_id: task.delegated_from_agent_id ?? null,
    input: (task.input ?? []).map((i) => ({ source: i.source, author_type: i.author_type, author_id: i.author_id, content: cap(i.content, 8000) })),
  };
}

async function archiveCommentEvent(deps) {
  const { cfg, queue, statusLog, taskApi, body, input, ws, ctx, mc, skip } = deps;
  const comment = input.comment;
  if (!comment?.id) return skip('comment event without comment.id');
  const authorType = comment.author_type ?? 'member';
  if (authorType === 'system') return skip('system notice, not a person or an agent', comment.id);
  if (comment.deleted_at) return skip('deleted comment', comment.id);
  if (!String(comment.content ?? '').trim()) return skip('empty comment', comment.id);
  const issueRef = comment.issue_id || body.issue_id;
  if (!issueRef) return skip('comment without an issue', comment.id);
  // A source_task_id alone does not prove that the conclusion was preserved.
  // When the closing comment arrives first, durably archive the terminal run
  // before testing its sanitized output. Partial/missing output keeps a comment
  // fallback, including when another run proved that the task API exists.
  if (authorType === 'agent' && comment.source_task_id) {
    const dedupeKey = `archive-run:${ws}:${comment.source_task_id}`;
    let run = queue.findByDedupeKey(dedupeKey);
    if (!run && taskApi.get(ctx.installationId) !== false) {
      let task = null;
      try {
        task = await mc.getTask(comment.source_task_id);
        taskApi.set(ctx.installationId, true);
      } catch { /* unknown: archive the comment */ }
      if (task && ['completed', 'failed'].includes(task.status) && task.agent_id === comment.author_id && task.issue_id === issueRef) {
        await archiveTaskEvent({ ...deps, prefetchedTask: task,
          input: { task_id: task.id, agent_id: task.agent_id, issue_id: task.issue_id, status: task.status },
          eventType: task.status === 'failed' ? 'task.failed' : 'task.completed',
        });
        run = queue.findByDedupeKey(dedupeKey);
      }
    }
    if (runCoversComment(run, comment, issueRef, cfg)) return skip('agent comment covered by its run archive', comment.id);
  }
  let issue;
  try {
    issue = await mc.getIssue(issueRef);
  } catch {
    // The comment body arrives inline; issue context is enrichment.
    issue = { id: issueRef, identifier: '', title: input.issue_title ?? '' };
  }
  const issueId = issue?.id || issueRef;
  const payload = {
    workspaceId: ws,
    installationId: ctx.installationId,
    refId: comment.id,
    agentId: authorType === 'agent' ? comment.author_id : undefined,
    comment: {
      id: comment.id, issue_id: issueId, author_type: authorType, author_id: comment.author_id ?? comment.author?.id ?? '',
      content: cap(comment.content, 8000), created_at: comment.created_at ?? '', source_task_id: comment.source_task_id ?? null,
    },
    issue: { id: issueId, identifier: issue?.identifier ?? '', title: issue?.title ?? '' },
    scope: { kind: 'task', workspaceId: ws, issueId },
    scopeKey: scopeKey('task', ws, issueId),
    completeness: 'complete',
  };
  const enq = queue.enqueue('archive-comment', payload, { dedupeKey: `archive-comment:${ws}:${comment.id}` });
  if (enq.reused) return { status: 'duplicate', job: enq.id };
  statusLog.append({ type: 'accepted', event: 'comment.created', ref: comment.id, author: authorType, scope: payload.scopeKey, job: enq.id, workspace: ws });
  return { status: 'queued', job: enq.id, author_type: authorType };
}

function runCoversComment(job, comment, issueId, cfg) {
  if (!job || job.status === 'failed' || job.payload.completeness !== 'complete' ||
      job.payload.agentId !== comment.author_id || job.payload.issue?.id !== issueId) return false;
  const normalize = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
  const wanted = normalize(comment.content);
  return buildJobMessages(job, cfg).messages.some((m) => m.role === 'assistant' &&
    (m.parts ?? []).some((part) => part.type === 'text' && normalize(part.text).includes(wanted)));
}

// ---------------------------------------------------------------------------
// multica agent tools
// ---------------------------------------------------------------------------

/**
 * The run an agent tool was called from. With multica's run context (task_id /
 * issue_id in the signed body) recall is bound to that run; without it (stock
 * builds) the agent may name an issue, as multica itself lets agents read any
 * issue in the workspace.
 */
async function resolveRun({ mc, body, ws, agentId }) {
  if (body.task_id) {
    try {
      const task = await mc.getTask(body.task_id);
      if (task?.agent_id === agentId) {
        const scopes = runScopes({ workspaceId: ws, task });
        if (scopes) return { bound: true, source: 'task', kind: task.kind, issueId: task.issue_id ?? null, readScopes: scopes.readScopes };
      }
    } catch { /* fall back to issue_id */ }
  }
  if (body.issue_id) {
    return {
      bound: true, source: 'issue', kind: 'issue', issueId: body.issue_id,
      readScopes: [scopeKey('task', ws, body.issue_id), scopeKey('agent', ws, agentId), scopeKey('shared', ws)],
    };
  }
  return { bound: false, source: 'none', kind: null, issueId: null, readScopes: [scopeKey('agent', ws, agentId), scopeKey('shared', ws)] };
}

async function canonicalIssueId(mc, ref) {
  try {
    const issue = await mc.getIssue(ref);
    return issue?.id ? String(issue.id) : null;
  } catch {
    return null;
  }
}

export function makeMemoryRecallHandler(deps) {
  const { cfg, ov, registry } = deps;
  return async function memoryRecall(body, ctx) {
    const deadline = Date.now() + cfg.recallBudgetMs;
    const input = body.input ?? {};
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!query) throw toolError('query is required');
    const merged = mergeCallConfig(cfg, body.config);
    const ws = ctx.workspaceId;
    const actor = body.actor ?? {};
    const agentId = actor.type === 'agent' ? actor.id : null;
    if (!agentId) throw toolError('memory-recall is only callable by an agent');

    const mc = callbackClient(deps, ctx, body, 8_000);
    const run = await resolveRun({ mc, body, ws, agentId });
    const notes = [];
    let scopeKeys = run.readScopes;
    if (input.issue_id) {
      // Keys like MUL-123 and UUIDs name the same issue; scopes are keyed by UUID.
      const requested = await canonicalIssueId(mc, input.issue_id);
      if (!requested) {
        notes.push(`issue_id ${input.issue_id} 无法解析,已忽略`);
      } else if (run.bound) {
        if (requested !== run.issueId) notes.push(`issue_id ${input.issue_id} 不属于当前运行;召回范围保持为当前运行`);
      } else {
        scopeKeys = [scopeKey('task', ws, requested), ...scopeKeys];
      }
    }
    const result = await recallFromScopes({
      ov, registry, scopeKeys, query,
      entries: Math.min(10, Math.max(1, Number(input.top_k) || merged.recallEntries)),
      perScopeLimit: merged.recallPerScopeLimit,
      contentMaxChars: merged.recallContentMaxChars,
      deadline,
    });
    const late = result.scopesSearched.filter((s) => s.timedOut).length;
    if (late) notes.push(`${late} 个记忆空间没有在时限内返回(OpenViking 检索慢),结果可能不完整;需要时可以稍后再查`);
    return {
      note: '参考证据：当前请求与实际执行结果优先；无相关内容时不要编造记忆。',
      run: { kind: run.kind, bound: run.bound },
      ...(notes.length ? { notes } : {}),
      ...result,
    };
  };
}

export function makeMemoryRememberHandler({ ov, registry, queue, extractions }) {
  return async function memoryRemember(body, ctx) {
    const input = body.input ?? {};
    const content = typeof input.content === 'string' ? input.content.trim() : '';
    if (!content) throw toolError('content is required');
    const actor = body.actor ?? {};
    if (actor.type !== 'agent' || !actor.id) {
      throw toolError('memory-remember is only callable by an agent (scope = agent public memory)');
    }
    const ws = ctx.workspaceId;
    const key = scopeKey('agent', ws, actor.id);
    const rec = await registry.ensureScope(key, { workspaceId: ws });
    const file = buildRememberFile({ title: input.title, content, kind: input.kind, agentId: actor.id });
    // Content-plane URIs must be absolute viking:// paths rooted in this user space.
    const fullUri = `viking://user/${rec.userId}/${file.uri}`;
    let status = 'remembered';
    try {
      await ov.writeContent(rec.apiKey, { uri: fullUri, content: file.content, mode: 'create' });
    } catch (err) {
      // Same title + content on the same day is the same file: remembering it
      // again is already done, not an error.
      if (isAlreadyExists(err)) status = 'already_remembered';
      else throw err;
    }
    // Submit one recursive folder rebuild through the durable queue. Separate
    // leaf/folder tasks contend for OV's locks, and accepted tasks can fail
    // later: the watcher must follow completion and re-drive failures.
    let indexJob;
    try {
      const dedupeKey = `index-memory:${key}:${fullUri}`;
      const existing = queue.findByDedupeKey(dedupeKey);
      if (existing?.status === 'done' && !extractions.isPinned(existing.id)) {
        // A repeat after settlement also repairs a previously failed index.
        indexJob = queue.requeue(existing.id, { reason: 'memory-remember requested reindex' });
      } else {
        const enqueued = queue.enqueue('index-memory', {
          workspaceId: ws, installationId: ctx.installationId, scopeKey: key, refId: fullUri,
          uri: fullUri.slice(0, fullUri.lastIndexOf('/')), completeness: 'complete',
        }, { dedupeKey });
        indexJob = { id: enqueued.id };
      }
    } catch (err) {
      throw toolError(`记忆已写入 ${fullUri}，索引任务未能持久化，请重试 memory-remember：${errText(err)}`, 'index_unavailable');
    }
    return {
      status,
      uri: fullUri,
      scope: key,
      index_job: indexJob.id,
      note: '已写入该智能体公共记忆，索引正在后台构建，完成后可被检索；请保持内容简洁、可复用、无敏感信息。',
    };
  };
}

export function makeMemoryStatusHandler({ ov, registry, queue, statusLog, extractions }) {
  return async function memoryStatus(body, ctx) {
    const ws = ctx.workspaceId;
    let ovHealth;
    try {
      ovHealth = await ov.health();
    } catch (err) {
      ovHealth = { status: 'unreachable', error: String(err.message ?? err) };
    }
    const scopeCount = Object.values(registry.data.scopes).filter((r) => r.workspaceId === ws).length;
    return {
      openviking: { healthy: ovHealth.healthy ?? ovHealth.status === 'ok', version: ovHealth.version ?? null },
      scopes: { scopes: scopeCount },
      archive_queue: queue.stats({ workspaceId: ws }),
      extraction: extractions.stats({ workspaceId: ws }),
      recent_archives: statusLog.recent({ limit: 10, workspaceId: ws }).map(publicStatusEntry),
    };
  };
}

function publicStatusEntry(e) {
  const { archive_uri, extraction_task, ...rest } = e;
  return rest;
}

// ---------------------------------------------------------------------------
// companion API (multica builds carrying memory companion capabilities)
// ---------------------------------------------------------------------------

export function makeInternalRecallHandler({ cfg, ov, registry }) {
  return async function internalRecall(body) {
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) throw httpError(400, 'invalid_request', 'query is required');
    if (!body.workspace_id) throw httpError(400, 'invalid_request', 'workspace_id is required');
    const scopeCtx = {
      workspaceId: body.workspace_id,
      agentId: body.agent_id ?? null,
      userId: body.user_id ?? null,
      issueId: body.issue_id ?? null,
      taskId: body.task_id ?? null,
      automationId: body.automation_id ?? null,
      fromAgentId: body.from_agent_id ?? null,
      toAgentId: body.to_agent_id ?? null,
      kind: ['task', 'chat', 'run', 'automation', 'delegation'].includes(body.kind) ? body.kind : 'task',
    };
    const scopeKeys = resolveReadScopes(scopeCtx);
    const result = await recallFromScopes({
      ov, registry, scopeKeys, query,
      entries: Math.min(10, Math.max(1, Number(body.entries) || cfg.recallEntries)),
      perScopeLimit: cfg.recallPerScopeLimit,
      contentMaxChars: cfg.recallContentMaxChars,
      deadline: Date.now() + cfg.recallBudgetMs,
    });
    return { ...result, injected_block: renderRecallBlock(result) };
  };
}

export function makeInternalEventHandler({ queue, ledger }) {
  return async function internalEvent(body) {
    const type = body.type;
    const ws = body.workspace_id;
    const payloadIn = body.payload ?? {};
    if (!ws) throw httpError(400, 'invalid_request', 'workspace_id is required');
    const need = (...names) => {
      const missing = names.filter((n) => !payloadIn[n]);
      if (missing.length) throw httpError(400, 'invalid_request', `${type} requires payload.${missing.join(', payload.')}`);
    };
    const deliveryKey = body.delivery_id ?? payloadIn.ref_id ?? shortHash(JSON.stringify(body));
    const ledgerKey = `companion:${type}:${deliveryKey}`;
    if (ledger.has(ledgerKey)) return { status: 'duplicate' };

    let outcome;
    switch (type) {
      case 'chat.completed': {
        const chatRef = payloadIn.chat_ref ?? payloadIn.ref_id;
        if (!chatRef) throw httpError(400, 'invalid_request', 'chat.completed requires payload.chat_ref');
        need('agent_id', 'user_id');
        // One chat has many turns: each turn is its own record and session.
        const turnKey = String(payloadIn.turn_id ?? body.delivery_id ?? shortHash(JSON.stringify(payloadIn.messages ?? [])));
        const payload = {
          workspaceId: ws, refId: chatRef, turnKey,
          messages: payloadIn.messages ?? [],
          scope: { kind: 'chat', workspaceId: ws, agentId: payloadIn.agent_id, userId: payloadIn.user_id },
          scopeKey: resolveArchiveScope({ workspaceId: ws, agentId: payloadIn.agent_id, userId: payloadIn.user_id, kind: 'chat' }),
          completeness: 'complete',
        };
        const enq = queue.enqueue('archive-chat', payload, { dedupeKey: `archive-chat:${ws}:${chatRef}:${turnKey}` });
        outcome = { status: 'queued', job: enq.id, turn: turnKey };
        break;
      }
      case 'task.input_appended': {
        need('issue_id');
        const appendId = payloadIn.append_id ?? payloadIn.ref_id;
        if (!appendId) throw httpError(400, 'invalid_request', 'task.input_appended requires payload.append_id');
        const payload = {
          workspaceId: ws, refId: appendId,
          content: payloadIn.content ?? '',
          delivered: payloadIn.delivered !== false,
          scope: { kind: 'task', workspaceId: ws, taskId: payloadIn.task_id, issueId: payloadIn.issue_id },
          scopeKey: resolveArchiveScope({ workspaceId: ws, issueId: payloadIn.issue_id, kind: 'task' }),
          completeness: 'complete',
        };
        const enq = queue.enqueue('archive-append', payload, { dedupeKey: `archive-append:${ws}:${appendId}` });
        outcome = { status: 'queued', job: enq.id };
        break;
      }
      case 'delegation.handoff': {
        need('from_agent_id', 'to_agent_id');
        const handoffId = payloadIn.handoff_id ?? payloadIn.ref_id;
        if (!handoffId) throw httpError(400, 'invalid_request', 'delegation.handoff requires payload.handoff_id');
        const payload = {
          workspaceId: ws, refId: handoffId,
          content: payloadIn.content ?? '',
          scope: { kind: 'delegation', workspaceId: ws, fromAgentId: payloadIn.from_agent_id, toAgentId: payloadIn.to_agent_id },
          scopeKey: resolveArchiveScope({ workspaceId: ws, fromAgentId: payloadIn.from_agent_id, toAgentId: payloadIn.to_agent_id, kind: 'delegation' }),
          completeness: 'complete',
        };
        const enq = queue.enqueue('archive-delegation', payload, { dedupeKey: `archive-deleg:${ws}:${handoffId}` });
        outcome = { status: 'queued', job: enq.id };
        break;
      }
      case 'automation.started':
        // Automation runs archive from their task.completed event (kind
        // "autopilot" → automation scope); starting one records nothing.
        outcome = { status: 'noted' };
        break;
      default:
        throw httpError(400, 'invalid_request', `unknown companion event type: ${type}`);
    }
    ledger.add(ledgerKey);
    return outcome;
  };
}

// ---------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------

export function makeAdminStatusHandler({ cfg, ov, registry, queue, statusLog, ledger, installations, extractions }) {
  return async function adminStatus() {
    let ovHealth = null;
    try {
      ovHealth = await ov.health();
    } catch (err) {
      ovHealth = { error: String(err.message ?? err) };
    }
    return {
      service: 'openviking-agent-memory',
      version: VERSION,
      ov: { base_url: cfg.ovBaseUrl, health: ovHealth },
      installations: installations.list(),
      scopes: registry.stats(),
      scope_keys: Object.keys(registry.data.scopes).map((k) => ({ scope: k, label: registry.data.scopes[k].label, provisioned_at: registry.data.scopes[k].provisionedAt })),
      queue: queue.stats(),
      queue_recent: queue.list({ limit: 20 }),
      extraction: extractions.stats(),
      recent_archives: statusLog.recent({ limit: 30 }),
      ledger_size: Object.keys(ledger.keys).length,
    };
  };
}

export function makeAdminTestRecallHandler({ cfg, ov, registry }) {
  return async function adminTestRecall(body) {
    const scopeKeys = Array.isArray(body.scopes) && body.scopes.length ? body.scopes : [scopeKey('shared', body.workspace_id)];
    return recallFromScopes({
      ov, registry, scopeKeys, query: body.query,
      entries: Math.min(10, Math.max(1, Number(body.entries) || cfg.recallEntries)),
    });
  };
}

/**
 * Run an archive job again as a new generation (a fresh OV session): the only
 * way to re-extract a record, since extraction reads a session's live messages
 * and a commit has already archived them.
 */
export function makeAdminRedriveHandler({ queue }) {
  return async function adminRedrive(body) {
    let job = body.job_id ? queue.jobs.get(body.job_id) : null;
    if (!job && body.session_id) {
      const sid = String(body.session_id);
      // The base session id names every generation of the record (-r1, -r2, …).
      job = [...queue.jobs.values()].find((j) => {
        const current = String(j.cp?.sessionId ?? '');
        return current === sid || current.startsWith(`${sid}-r`) || sid.startsWith(`${current}-r`);
      }) ?? null;
    }
    if (!job) throw httpError(404, 'not_found', 'no archive job for that job_id / session_id (it may have been compacted away)');
    if (job.status === 'queued' || job.status === 'running') {
      throw httpError(409, 'conflict', `job ${job.id} is already ${job.status}`);
    }
    const requeued = queue.requeue(job.id, { reason: 'manual redrive' });
    return { redriven: job.id, generation: requeued.payload.generation, status: requeued.status };
  };
}

export function makeAdminConsolidateHandler({ ov, registry, cfg, log }) {
  return async function adminConsolidate(body) {
    if (!body.workspace_id) throw httpError(400, 'invalid_request', 'workspace_id is required');
    return consolidateShared({
      ov, registry, workspaceId: body.workspace_id, stateDir: cfg.stateDir,
      perScopeLimit: Math.min(20, Math.max(1, Number(body.per_scope_limit) || 8)),
      log,
    });
  };
}

// ---------------------------------------------------------------------------
// HTTP wiring
// ---------------------------------------------------------------------------

function errorBody(err) {
  return { status: 'error', error: { code: err.code ?? 'internal', message: String(err.message ?? err) } };
}

async function route({ req, rawBody, cfg, app }) {
  const url = new URL(req.url, 'http://local');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && (path === '/healthz' || path === '/health')) {
    let ov;
    try {
      const h = await app.ov.health();
      ov = { healthy: true, version: h.version ?? null };
    } catch {
      ov = { healthy: false };
    }
    return { status: 200, body: { status: 'ok', result: { service: 'openviking-agent-memory', version: VERSION, ov } } };
  }

  if (path.startsWith('/hooks/')) {
    if (req.method !== 'POST') throw httpError(405, 'method_not_allowed', 'hooks accept POST only');
    const ctx = await app.installations.authenticate({ headers: req.headers, rawBody });
    const body = ctx.body;
    const hookKey = path.slice('/hooks/'.length);
    const handler = hookKey.startsWith('ov-') ? app.handlers.ov : app.handlers[hookKey];
    if (!handler) throw httpError(404, 'not_found', `unknown hook ${hookKey}`);
    try {
      return { status: 200, body: { status: 'ok', result: await handler(body, ctx) } };
    } catch (err) {
      log(`hook ${hookKey} (${ctx.installationId}) failed: ${err.message}`);
      if (hookKey === 'memory-archive') {
        app.statusLog.append({ type: 'error', event: body.event_type, workspace: ctx.workspaceId, error: String(err.message ?? err).slice(0, 300) });
      }
      // Event delivery must retry when durable acceptance failed. Agent tools
      // still expose failures as readable results.
      const payload = errorBody(err);
      if (hookKey.startsWith('ov-')) payload.tool = hookKey.replace(/^ov-/, '').replace(/-/g, '_');
      return { status: hookKey === 'memory-archive' ? 503 : 200, body: payload };
    }
  }

  if (path.startsWith('/internal/') || path.startsWith('/admin/')) {
    if (req.method !== 'POST' && path.startsWith('/internal/')) throw httpError(405, 'method_not_allowed', 'internal accepts POST only');
    if (!(path.startsWith('/admin/') && req.method === 'GET') && req.method !== 'POST') {
      throw httpError(405, 'method_not_allowed', 'POST required');
    }
    if (!bearerMatches(req, cfg.pluginToken)) throw httpError(401, 'unauthenticated', 'valid bearer token required');
    const body = req.method === 'POST' ? parseJsonBody(rawBody) : {};
    const ok = (result) => ({ status: 200, body: { status: 'ok', result } });
    if (path === '/internal/recall') return ok(await app.handleInternalRecall(body));
    if (path === '/internal/events') return ok(await app.handleInternalEvent(body));
    if (path === '/admin/status') return ok(await app.handleAdminStatus());
    if (path === '/admin/test-recall') return ok(await app.handleAdminTestRecall(body));
    if (path === '/admin/consolidate') return ok(await app.handleAdminConsolidate(body));
    if (path === '/admin/redrive') return ok(await app.handleAdminRedrive(body));
    throw httpError(404, 'not_found', `unknown endpoint ${path}`);
  }

  throw httpError(404, 'not_found', `no route for ${req.method} ${path}`);
}

function bearerMatches(req, token) {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ') || !token) return false;
  return safeEqual(h.slice(7), token);
}

function parseJsonBody(raw) {
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw httpError(400, 'invalid_request', 'body is not valid JSON');
  }
}

export function httpError(status, code, message) {
  const e = new Error(message);
  e.httpStatus = status;
  e.code = code;
  return e;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main() {
  const cfg = loadConfig();
  const problems = validateStartupConfig(cfg);
  if (problems.length) {
    console.error('configuration problems:\n  - ' + problems.join('\n  - '));
    process.exit(2);
  }
  let lock;
  try {
    lock = await acquireStateLock({
      stateDir: cfg.stateDir,
      log,
      onLost: () => {
        console.error('state lock lost to another writer; exiting');
        process.exit(3);
      },
    });
  } catch (err) {
    console.error(err.message);
    process.exit(3);
  }
  const ov = new OvClient({ baseUrl: cfg.ovBaseUrl, timeoutMs: cfg.ovTimeoutMs });
  const registry = new ScopeRegistry({ ov, rootKey: cfg.ovRootKey, stateDir: cfg.stateDir, log });
  const installations = new InstallationRegistry({ stateDir: cfg.stateDir, cfg, log });
  const ledger = new Ledger({ stateDir: cfg.stateDir });
  const statusLog = new ArchiveStatusLog({ stateDir: cfg.stateDir, maxBytes: cfg.statusLogMaxBytes });
  const { queue, extractions } = createArchiveProcessing({ ov, registry, statusLog, cfg, log });
  queue.start();
  extractions.start();
  const app = createApp({ cfg, ov, registry, queue, ledger, statusLog, installations, extractions });

  const handler = await buildRequestListener({ cfg, app });
  let server;
  if (cfg.tlsCert && cfg.tlsKey) {
    const { createServer: httpsServer } = await import('node:https');
    server = httpsServer({ key: readFileSync(cfg.tlsKey), cert: readFileSync(cfg.tlsCert) }, handler);
  } else {
    server = createServer(handler);
  }
  await new Promise((resolve, reject) => server.once('error', reject).listen(cfg.port, cfg.bind, resolve));
  log(`openviking-agent-memory ${VERSION} listening on ${cfg.tlsCert ? 'https' : 'http'}://${cfg.bind}:${cfg.port}`);
  installShutdown({ server, queue, extractions, lock });
  return server;
}

export async function buildRequestListener({ cfg, app }) {
  return async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rawBody = Buffer.concat(chunks);
    const started = Date.now();
    try {
      const { status, body } = await route({ req, rawBody, cfg, app });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    } catch (err) {
      res.writeHead(err.httpStatus ?? 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(errorBody(err)));
    } finally {
      log(`${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started}ms)`);
    }
  };
}

function installShutdown({ server, queue, extractions, lock }) {
  const shutdown = async (sig) => {
    log(`received ${sig}, draining…`);
    extractions.stop();
    await queue.stop({ drainMs: 5_000 }).catch(() => {});
    lock.release();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 7_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('fatal:', err);
    process.exit(1);
  });
}
