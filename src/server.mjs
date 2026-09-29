#!/usr/bin/env node
/**
 * OpenViking Agent Memory — Multica plugin backend service.
 *
 * Surface:
 *   POST /hooks/memory-archive    multica event hook (task.completed/failed, comment.created), HMAC-signed
 *   POST /hooks/memory-recall     multica agent tool (scoped multi-space recall)
 *   POST /hooks/memory-remember   multica agent tool (active write into agent-public memory)
 *   POST /hooks/memory-status     multica agent tool (service + archive processing status)
 *   POST /internal/recall         companion API: scoped recall for claim-time injection
 *   POST /internal/events         companion API: chat / append / automation / delegation events
 *   GET  /healthz                 liveness + dependency snapshot (no auth)
 *   GET  /admin/status            operator status dump (bearer OVMEM_PLUGIN_TOKEN)
 *   POST /admin/test-recall       operator recall probe
 *
 * Everything long-running goes through the durable queue; hook handlers ACK
 * fast (multica times out at timeout_ms) after fetching callback ingredients.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { loadConfig, validateStartupConfig, mergeCallConfig } from './config.mjs';
import { verifyHookDelivery } from './hmac.mjs';
import { OvClient } from './ov-client.mjs';
import { MulticaClient } from './multica-client.mjs';
import { ScopeRegistry, resolveReadScopes, resolveArchiveScope, scopeKey } from './scopes.mjs';
import { recallFromScopes, renderRecallBlock } from './recall.mjs';
import { JobQueue } from './queue.mjs';
import { makeArchiveHandler } from './pipeline.mjs';
import { Ledger, ArchiveStatusLog } from './ledger.mjs';
import { buildRememberFile } from './archive.mjs';
import { makeOvToolHandler } from './ov-facade.mjs';
import { consolidateShared } from './consolidate.mjs';
import { safeEqual } from './util.mjs';

const log = (...args) => console.log(new Date().toISOString(), ...args);

export function createApp({ cfg, ov, registry, queue, ledger, statusLog } = {}) {
  const deps = { cfg, ov, registry, queue, ledger, statusLog };
  const ovTool = makeOvToolHandler(deps);
  return {
    cfg, ov, registry, queue, ledger, statusLog,
    handlers: {
      'memory-archive': makeMemoryArchiveHandler(deps),
      'memory-recall': makeMemoryRecallHandler(deps),
      'memory-remember': makeMemoryRememberHandler(deps),
      'memory-status': makeMemoryStatusHandler(deps),
      // ov-<native-tool> facade hooks all share one handler
      ov: ovTool,
    },
    handleInternalRecall: makeInternalRecallHandler(deps),
    handleInternalEvent: makeInternalEventHandler(deps),
    handleAdminStatus: makeAdminStatusHandler(deps),
    handleAdminTestRecall: makeAdminTestRecallHandler(deps),
    handleAdminConsolidate: makeAdminConsolidateHandler(deps),
  };
}

// ---------------------------------------------------------------------------
// multica event hook: memory-archive
// ---------------------------------------------------------------------------

export function makeMemoryArchiveHandler({ cfg, ov, registry, queue, ledger, statusLog }) {
  return async function memoryArchive(body) {
    const eventType = body.event_type ?? '';
    const input = body.input ?? {};
    const ws = body.workspace_id;
    const ledgerKey = body.invocation_id
      ? `inv:${body.invocation_id}`
      : `evt:${eventType}:${input.task_id ?? input.comment?.id ?? ''}:${body.occurred_at ?? ''}`;
    if (ledger.has(ledgerKey)) {
      return { status: 'duplicate', ledger: ledgerKey };
    }

    // Fetch ingredients NOW while the callback token is alive (5-min TTL),
    // then hand the payload to the durable queue for OV archiving.
    const mc = new MulticaClient({
      callbackUrl: body.callback_url,
      callbackToken: body.callback_token,
      timeoutMs: cfg.callbackTimeoutMs,
    });

    if (eventType === 'task.completed' || eventType === 'task.failed') {
      const taskId = input.task_id;
      const agentId = input.agent_id;
      const issueId = input.issue_id;
      if (!taskId || !issueId) throw new Error('task event missing task_id/issue_id');
      const payload = {
        workspaceId: ws,
        refId: taskId,
        status: eventType === 'task.failed' ? 'failed' : (input.status ?? 'completed'),
        scope: { kind: 'task', workspaceId: ws, agentId, issueId, taskId },
        scopeKey: resolveArchiveScope({ workspaceId: ws, agentId, issueId, taskId, kind: 'task' }),
        completeness: 'complete',
      };
      try {
        payload.issue = unwrapIssue(await mc.getIssue(issueId));
      } catch (err) {
        payload.issue = { id: issueId, identifier: '', title: '(issue body unavailable)', description: '' };
        payload.completeness = `partial: issue fetch failed (${err.message})`;
      }
      try {
        const transcript = await mc.getTaskMessages(taskId, { includeThinking: cfg.includeThinking });
        payload.transcript = Array.isArray(transcript?.messages) ? transcript.messages : [];
        if (!payload.transcript.length) {
          payload.completeness = payload.completeness === 'complete'
            ? 'partial: transcript endpoint empty or unavailable'
            : `${payload.completeness}; transcript empty`;
        }
      } catch (err) {
        payload.transcript = [];
        payload.completeness = `${payload.completeness === 'complete' ? 'partial' : payload.completeness}: transcript unavailable (${err.status ?? ''} ${err.message})`.slice(0, 300);
      }
      ledger.add(ledgerKey);
      const enq = queue.enqueue('archive-run', payload, { dedupeKey: `archive-run:${ws}:${taskId}` });
      statusLog.append({ type: 'accepted', event: eventType, ref: taskId, scope: payload.scopeKey, job: enq.id, completeness: payload.completeness });
      return { status: 'queued', job: enq.id, completeness: payload.completeness };
    }

    if (eventType === 'comment.created') {
      const comment = input.comment;
      const issueId = input.comment?.issue_id ?? body.issue_id;
      if (!comment?.id || !issueId) throw new Error('comment event missing comment.id/issue_id');
      let issue = null;
      try {
        issue = unwrapIssue(await mc.getIssue(issueId));
      } catch { /* comment body arrives inline; issue context is enrichment */ }
      ledger.add(ledgerKey);
      const payload = {
        workspaceId: ws,
        refId: comment.id,
        comment,
        issue: issue ?? { id: issueId, identifier: '', title: '' },
        scope: { kind: 'task', workspaceId: ws, issueId },
        scopeKey: resolveArchiveScope({ workspaceId: ws, issueId, kind: 'task' }),
        completeness: 'complete',
      };
      const enq = queue.enqueue('archive-comment', payload, { dedupeKey: `archive-comment:${ws}:${comment.id}` });
      statusLog.append({ type: 'accepted', event: eventType, ref: comment.id, scope: payload.scopeKey, job: enq.id });
      return { status: 'queued', job: enq.id };
    }

    throw new Error(`memory-archive: unsupported event_type ${eventType}`);
  };
}

function unwrapIssue(resp) {
  if (resp && typeof resp === 'object' && 'issue' in resp) return resp.issue;
  return resp;
}

// ---------------------------------------------------------------------------
// multica agent tools
// ---------------------------------------------------------------------------

export function makeMemoryRecallHandler({ cfg, ov, registry }) {
  return async function memoryRecall(body) {
    const input = body.input ?? {};
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!query) throw new Error('query is required');
    const merged = mergeCallConfig(cfg, body.config);
    const ws = body.workspace_id;
    const actor = body.actor ?? {};
    const agentId = actor.type === 'agent' ? actor.id : null;

    const scopeCtx = { workspaceId: ws, agentId, kind: 'task' };
    if (input.issue_id) {
      // Verify the issue is readable with this invocation's grant before
      // letting the caller widen recall into that task's collaboration scope.
      try {
        const mc = new MulticaClient({
          callbackUrl: body.callback_url, callbackToken: body.callback_token, timeoutMs: cfg.callbackTimeoutMs,
        });
        await mc.getIssue(input.issue_id);
        scopeCtx.issueId = input.issue_id;
      } catch (err) {
        log(`memory-recall: issue ${input.issue_id} could not be verified (${err.message}); recalling without the task scope`);
      }
    }
    const scopeKeys = resolveReadScopes(scopeCtx);
    const result = await recallFromScopes({
      ov, registry, scopeKeys, query,
      entries: Math.min(10, Math.max(1, Number(input.top_k) || merged.recallEntries)),
      perScopeLimit: merged.recallPerScopeLimit,
      contentMaxChars: merged.recallContentMaxChars,
    });
    return {
      note: '参考证据：当前请求与实际执行结果优先；无相关内容时不要编造记忆。',
      ...result,
    };
  };
}

export function makeMemoryRememberHandler({ cfg, ov, registry }) {
  return async function memoryRemember(body) {
    const input = body.input ?? {};
    const content = typeof input.content === 'string' ? input.content.trim() : '';
    if (!content) throw new Error('content is required');
    const actor = body.actor ?? {};
    if (actor.type !== 'agent' || !actor.id) {
      throw new Error('memory-remember is only callable by an agent (scope = agent public memory)');
    }
    const ws = body.workspace_id;
    const key = scopeKey('agent', ws, actor.id);
    const rec = await registry.ensureScope(key, { workspaceId: ws });
    const file = buildRememberFile({
      title: input.title, content, kind: input.kind, agentId: actor.id,
    });
    // Content-plane URIs must be absolute viking:// paths rooted in this user space.
    const fullUri = `viking://user/${rec.userId}/${file.uri}`;
    await ov.writeContent(rec.apiKey, { uri: fullUri, content: file.content, mode: 'create' });
    try {
      await ov.reindex(rec.apiKey, fullUri);
    } catch { /* reindex is enrichment; extraction-free write still readable */ }
    return {
      status: 'remembered',
      uri: fullUri,
      scope: key,
      note: '已写入该智能体公共记忆；请保持内容简洁、可复用、无敏感信息。',
    };
  };
}

export function makeMemoryStatusHandler({ cfg, ov, registry, queue, statusLog }) {
  return async function memoryStatus() {
    let ovHealth = { status: 'unreachable' };
    try {
      ovHealth = await ov.health();
    } catch (err) {
      ovHealth = { status: 'unreachable', error: String(err.message ?? err) };
    }
    return {
      openviking: {
        healthy: ovHealth.healthy ?? ovHealth.status === 'ok',
        version: ovHealth.version ?? null,
      },
      scopes: registry.stats(),
      archive_queue: queue.stats(),
      recent_archives: statusLog.recent({ limit: 10 }),
    };
  };
}

// ---------------------------------------------------------------------------
// companion API (multica builds carrying memory companion capabilities)
// ---------------------------------------------------------------------------

export function makeInternalRecallHandler({ cfg, ov, registry }) {
  return async function internalRecall(body) {
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) throw new Error('query is required');
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
    });
    return { ...result, injected_block: renderRecallBlock(result) };
  };
}

export function makeInternalEventHandler({ queue, ledger, cfg }) {
  return async function internalEvent(body) {
    const type = body.type;
    const ws = body.workspace_id;
    const payloadIn = body.payload ?? {};
    const ledgerKey = `companion:${type}:${payloadIn.ref_id ?? body.delivery_id ?? JSON.stringify(body).length}`;
    if (ledger.has(ledgerKey)) return { status: 'duplicate' };

    switch (type) {
      case 'chat.completed': {
        ledger.add(ledgerKey);
        const payload = {
          workspaceId: ws, refId: payloadIn.chat_ref ?? payloadIn.ref_id,
          messages: payloadIn.messages ?? [],
          scope: { kind: 'chat', workspaceId: ws, agentId: payloadIn.agent_id, userId: payloadIn.user_id },
          scopeKey: resolveArchiveScope({ workspaceId: ws, agentId: payloadIn.agent_id, userId: payloadIn.user_id, kind: 'chat' }),
          completeness: 'complete',
        };
        const enq = queue.enqueue('archive-chat', payload, { dedupeKey: `archive-chat:${ws}:${payload.refId}` });
        return { status: 'queued', job: enq.id };
      }
      case 'task.input_appended': {
        ledger.add(ledgerKey);
        const payload = {
          workspaceId: ws, refId: payloadIn.append_id ?? payloadIn.ref_id,
          content: payloadIn.content ?? '',
          delivered: payloadIn.delivered !== false,
          scope: { kind: 'task', workspaceId: ws, taskId: payloadIn.task_id, issueId: payloadIn.issue_id },
          scopeKey: resolveArchiveScope({ workspaceId: ws, issueId: payloadIn.issue_id, kind: 'task' }),
          completeness: 'complete',
        };
        const enq = queue.enqueue('archive-append', payload, { dedupeKey: `archive-append:${ws}:${payload.refId}` });
        return { status: 'queued', job: enq.id };
      }
      case 'delegation.handoff': {
        ledger.add(ledgerKey);
        const payload = {
          workspaceId: ws, refId: payloadIn.handoff_id ?? payloadIn.ref_id,
          content: payloadIn.content ?? '',
          scope: { kind: 'delegation', workspaceId: ws, fromAgentId: payloadIn.from_agent_id, toAgentId: payloadIn.to_agent_id },
          scopeKey: resolveArchiveScope({ workspaceId: ws, fromAgentId: payloadIn.from_agent_id, toAgentId: payloadIn.to_agent_id, kind: 'delegation' }),
          completeness: 'complete',
        };
        const enq = queue.enqueue('archive-delegation', payload, { dedupeKey: `archive-deleg:${ws}:${payload.refId}` });
        return { status: 'queued', job: enq.id };
      }
      case 'automation.started': {
        // Automation runs that create issues archive through the normal task
        // path; automation-scope archiving happens on run completion.
        return { status: 'noted' };
      }
      default:
        throw new Error(`unknown companion event type: ${type}`);
    }
  };
}

// ---------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------

export function makeAdminStatusHandler({ cfg, ov, registry, queue, statusLog, ledger }) {
  return async function adminStatus() {
    let ovHealth = null;
    try {
      ovHealth = await ov.health();
    } catch (err) {
      ovHealth = { error: String(err.message ?? err) };
    }
    return {
      service: 'openviking-agent-memory',
      version: '0.1.0',
      ov: { base_url: cfg.ovBaseUrl, health: ovHealth },
      scopes: registry.stats(),
      scope_keys: Object.keys(registry.data.scopes).map((k) => ({ scope: k, label: registry.data.scopes[k].label, provisioned_at: registry.data.scopes[k].provisionedAt })),
      queue: queue.stats(),
      queue_recent: queue.list({ limit: 20 }),
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

export function makeAdminConsolidateHandler({ ov, registry, log }) {
  return async function adminConsolidate(body) {
    if (!body.workspace_id) throw httpError(400, 'invalid_request', 'workspace_id is required');
    return consolidateShared({
      ov, registry, workspaceId: body.workspace_id,
      perScopeLimit: Math.min(20, Math.max(1, Number(body.per_scope_limit) || 8)),
      log,
    });
  };
}

// ---------------------------------------------------------------------------
// HTTP wiring
// ---------------------------------------------------------------------------

function resultEnvelope(err, payload) {
  if (err) {
    return { status: 'error', error: { code: err.code ?? 'internal', message: String(err.message ?? err) } };
  }
  return { status: 'ok', result: payload ?? {} };
}

async function route({ req, rawBody, cfg, app }) {
  const url = new URL(req.url, 'http://local');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && (path === '/healthz' || path === '/health')) {
    let ov = null;
    try {
      const h = await app.ov.health();
      ov = { healthy: true, version: h.version ?? null };
    } catch (err) {
      ov = { healthy: false };
    }
    return { status: 200, headers: { body: { service: 'openviking-agent-memory', ov, queue: app.queue.stats() } } };
  }

  if (path.startsWith('/hooks/')) {
    if (req.method !== 'POST') throw httpError(405, 'method_not_allowed', 'hooks accept POST only');
    // One service may serve several workspace installations; each signs with
    // its own per-installation secret. Try the primary, then the extras —
    // prefer the secret pinned to this installation when present.
    const installation = req.headers['x-multica-plugin-installation'];
    const candidates = [
      cfg.signingSecrets?.[installation],
      cfg.signingSecret,
      ...Object.values(cfg.signingSecrets ?? {}),
    ].filter(Boolean);
    let v = { ok: false, reason: 'no signing secret configured' };
    for (const secret of candidates) {
      v = verifyHookDelivery({
        secret,
        timestamp: req.headers['x-multica-timestamp'],
        signature: req.headers['x-multica-signature'],
        rawBody,
        installation,
      });
      if (v.ok) break;
    }
    if (!v.ok) throw httpError(401, 'invalid_signature', `hook signature verification failed: ${v.reason}`);
    const body = parseJsonBody(rawBody);
    const hookKey = path.slice('/hooks/'.length);
    if (hookKey.startsWith('ov-')) {
      // Native MCP tool errors (bad uri, invalid args) are TOOL errors, not
      // transport failures — return them as payload so the agent reads the
      // original OV message, exactly as a direct MCP client would.
      try {
        const result = await app.handlers.ov(body);
        return { status: 200, headers: { body: result } };
      } catch (err) {
        return { status: 200, headers: { body: { tool: String(hookKey).replace(/^ov-/, ''), error: String(err.message ?? err) } } };
      }
    }
    const handler = app.handlers[hookKey];
    if (!handler) throw httpError(404, 'not_found', `unknown hook ${hookKey}`);
    const result = await handler(body);
    return { status: 200, headers: { body: result } };
  }

  if (path.startsWith('/internal/') || path.startsWith('/admin/')) {
    if (req.method !== 'POST' && path.startsWith('/internal/')) throw httpError(405, 'method_not_allowed', 'internal accepts POST only');
    if (!(path.startsWith('/admin/') && req.method === 'GET') && req.method !== 'POST') {
      throw httpError(405, 'method_not_allowed', 'POST required');
    }
    if (!bearerMatches(req, cfg.pluginToken)) throw httpError(401, 'unauthenticated', 'valid bearer token required');
    const body = req.method === 'POST' ? parseJsonBody(rawBody) : {};
    if (path === '/internal/recall') return { status: 200, headers: { body: await app.handleInternalRecall(body) } };
    if (path === '/internal/events') return { status: 200, headers: { body: await app.handleInternalEvent(body) } };
    if (path === '/admin/status') return { status: 200, headers: { body: await app.handleAdminStatus() } };
    if (path === '/admin/test-recall') return { status: 200, headers: { body: await app.handleAdminTestRecall(body) } };
    if (path === '/admin/consolidate') return { status: 200, headers: { body: await app.handleAdminConsolidate(body) } };
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
    console.error('missing configuration:\n  - ' + problems.join('\n  - '));
    process.exit(2);
  }
  const ov = new OvClient({ baseUrl: cfg.ovBaseUrl, timeoutMs: cfg.ovTimeoutMs });
  const registry = new ScopeRegistry({ ov, rootKey: cfg.ovRootKey, stateDir: cfg.stateDir, log });
  const ledger = new Ledger({ stateDir: cfg.stateDir });
  const statusLog = new ArchiveStatusLog({ stateDir: cfg.stateDir });
  const queue = new JobQueue({
    stateDir: cfg.stateDir,
    handler: makeArchiveHandler({ ov, registry, statusLog, cfg, log }),
    maxAttempts: cfg.queueMaxAttempts,
    baseDelayMs: cfg.queueBaseDelayMs,
    log,
  });
  queue.start();
  const app = createApp({ cfg, ov, registry, queue, ledger, statusLog });

  const handler = await buildRequestListener({ cfg, app });
  let server;
  if (cfg.tlsCert && cfg.tlsKey) {
    const { createServer: httpsServer } = await import('node:https');
    server = httpsServer({ key: readFileSync(cfg.tlsKey), cert: readFileSync(cfg.tlsCert) }, handler);
  } else {
    server = createServer(handler);
  }
  await new Promise((resolve, reject) => server.once('error', reject).listen(cfg.port, cfg.bind, resolve));
  log(`listening on ${cfg.tlsCert ? 'https' : 'http'}://${cfg.bind}:${cfg.port}`);
  installShutdown(server, queue);
  return server;
}

export async function buildRequestListener({ cfg, app }) {
  return async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rawBody = Buffer.concat(chunks);
    const started = Date.now();
    try {
      const { status, headers } = await route({ req, rawBody, cfg, app });
      const body = JSON.stringify(resultEnvelope(null, headers?.body));
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch (err) {
      res.writeHead(err.httpStatus ?? 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resultEnvelope(err)));
    } finally {
      log(`${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started}ms)`);
    }
  };
}

function installShutdown(server, queue) {
  const shutdown = async (sig) => {
    log(`received ${sig}, draining…`);
    await queue.stop({ drainMs: 5_000 }).catch(() => {});
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
