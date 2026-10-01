import { cap, nowIso, readJsonIfExists, atomicWriteJson, shortHash } from './util.mjs';
import { scopeKey } from './scopes.mjs';
import { join } from 'node:path';

/**
 * Shared-memory promotion: distil durable knowledge from the workspace's
 * agent-public and task-collaboration spaces into the workspace shared space.
 *
 * Writes are durably queued through OpenViking's session→commit→extraction pipeline
 * (one session per run) — the same mechanism that makes agent-public memories
 * searchable — so promoted entries get real L0/L1 layers and semantic index
 * entries. Idempotency is tracked in {stateDir}/consolidated.json (source scope
 * plus URI); extraction monitoring and re-drives use the archive queue.
 */
const PROMOTABLE_KINDS = ['experiences', 'cases', 'preferences', 'entities'];

export async function consolidateShared({
  ov, registry, queue, workspaceId, stateDir, replaySessionId,
  perScopeLimit = 8, maxPerRun = 12, contentMinChars = 30, log = () => {},
}) {
  const sharedScope = scopeKey('shared', workspaceId);
  const shared = await registry.ensureScope(sharedScope, { workspaceId });
  if (replaySessionId) return replayFailedPromotion({ ov, shared, queue, workspaceId, sharedScope, sessionId: replaySessionId });
  const donePath = join(stateDir, 'consolidated.json');
  const done = readJsonIfExists(donePath, { files: {} });
  done.files ??= {};
  // Enqueue is authoritative if writing the separate receipt file failed.
  // Recover its keys before selecting a batch that may now include new files.
  let recovered = false;
  for (const job of queue.jobs.values()) {
    if (job.type !== 'consolidate' || job.payload.workspaceId !== workspaceId) continue;
    for (const key of job.payload.promotedKeys ?? []) if (!done.files[key]) {
      done.files[key] = job.created_at; recovered = true;
    }
  }
  if (recovered) atomicWriteJson(donePath, done);

  const sourceScopes = Object.keys(registry.data.scopes).filter(
    (k) => k.startsWith(`agent:${workspaceId}:`) || k.startsWith(`task:${workspaceId}:`),
  );

  const selected = [];
  // Promotion copies agent-public and task memories into the space every agent
  // in the workspace reads; the skill tells agents this can happen.
  outer: for (const scopeKeyStr of sourceScopes) {
    const rec = registry.get(scopeKeyStr);
    if (!rec) continue;
    let files;
    try {
      files = await walkKinds(ov, rec.apiKey, rec.userId);
    } catch (err) {
      log(`consolidate: skip ${scopeKeyStr} (${err.message})`);
      continue;
    }
    files.sort((a, b) => String(b.modTime ?? '').localeCompare(String(a.modTime ?? '')));
    let taken = 0;
    for (const f of files) {
      if (selected.length >= maxPerRun) break outer;
      if (taken >= perScopeLimit) break;
      // Keyed by source scope + full URI: memory files from different spaces
      // routinely share a basename, and must not block each other. Older state
      // files keyed by basename are still honoured.
      const base = basename(f.uri);
      const doneKey = `${scopeKeyStr}|${f.uri}`;
      if (done.files[doneKey] || done.files[base] || existingIn(selected, doneKey)) continue;
      let content;
      try {
        const r = await ov.readContent(rec.apiKey, f.uri, { limit: 400 });
        content = r?.content;
      } catch { continue; }
      if (!content || content.length < contentMinChars) continue;
      selected.push({ from: scopeKeyStr, file: base, key: doneKey, content });
      taken++;
    }
  }

  if (!selected.length) {
    return { shared_scope: sharedScope, sources: sourceScopes.length, promoted: [], note: 'nothing new to promote' };
  }

  // One session, one message per promoted memory — extraction distils them
  // into properly-indexed shared memories.
  // Stable batch identity also covers an idempotency-file write failing after
  // enqueue: the next call finds the same persisted job instead of duplicating
  // a native commit. Payloads remain available for extraction re-drives.
  const sessionId = `mc-consolidate-${shortHash(JSON.stringify(selected))}`;
  const messages = selected.map((s, i) => ({
    role: 'user',
    message_kind: 'user_query',
    turn_id: `promote-${i}`,
    content: `【共享记忆晋升 #${i + 1}】来源范围: ${s.from}\n原文件: ${s.file}\n内容:\n${cap(s.content, 3500)}`,
  }));
  const job = enqueuePromotion({ queue, workspaceId, sharedScope, sessionId, messages, promotedKeys: selected.map(s => s.key) });
  for (const s of selected) done.files[s.key] = nowIso();
  atomicWriteJson(donePath, done);
  log(`consolidate: ${selected.length} memories durably queued for shared-space extraction (${sessionId})`);
  return {
    shared_scope: sharedScope,
    sources: sourceScopes.length,
    promoted: selected.map(({ file, from }) => ({ file, from })),
    session_id: sessionId,
    status: 'queued', job_id: job.id, extraction_task: null,
  };
}

function enqueuePromotion({ queue, workspaceId, sharedScope, sessionId, messages, promotedKeys = [] }) {
  return queue.enqueue('consolidate', {
    workspaceId, scopeKey: sharedScope, refId: sessionId, sessionId, messages, promotedKeys,
  }, { dedupeKey: `consolidate:${workspaceId}:${sessionId}` });
}

// Recover a failed promotion created before consolidation used the queue.
// Read only this workspace's shared user space and require failure evidence.
async function replayFailedPromotion({ ov, shared, queue, workspaceId, sharedScope, sessionId }) {
  const reject = (httpStatus, code, message) => { throw Object.assign(new Error(message), { httpStatus, code }); };
  if (typeof sessionId !== 'string' || !/^mc-consolidate-[A-Za-z0-9_.-]{1,180}$/.test(sessionId)) reject(400, 'invalid_request', 'Invalid consolidation session ID');
  const tasks = await ov.listTasks(shared.apiKey, { resourceId: sessionId });
  const latest = [...tasks].sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))[0];
  const archive = `viking://user/${shared.userId}/sessions/${sessionId}/history/archive_001`;
  if (latest && !['failed', 'cancelled'].includes(latest.status)) reject(409, 'not_failed', 'Only a failed consolidation can be replayed');
  if (!latest) {
    try { await ov.readContent(shared.apiKey, `${archive}/.failed.json`); }
    catch { reject(409, 'not_failed', 'No failed consolidation evidence is available'); }
  }
  const raw = (await ov.readContent(shared.apiKey, `${archive}/messages.jsonl`)).content ?? '';
  const messages = raw.split('\n').filter(line => line.trim()).map((line, i) => {
    const message = JSON.parse(line);
    const textParts = Array.isArray(message.parts) && message.parts.length > 0 && message.parts.every(p => p.type === 'text' && typeof p.text === 'string');
    const content = typeof message.content === 'string' ? message.content : textParts ? message.parts.map(p => p.text).join('\n') : null;
    if (message.role !== 'user' || content === null) reject(400, 'invalid_archive', 'Invalid consolidation message');
    return { role: 'user', message_kind: 'user_query', turn_id: message.turn_id ?? `promote-${i}`, content };
  });
  if (!messages.length) reject(400, 'invalid_archive', 'Consolidation archive has no messages');
  const job = enqueuePromotion({ queue, workspaceId, sharedScope, sessionId, messages });
  return { shared_scope: sharedScope, sources: 0, promoted: [], session_id: sessionId, replay_of: sessionId, status: 'queued', job_id: job.id };
}

async function walkKinds(ov, key, userId) {
  return walkDirs(ov, key, userId, PROMOTABLE_KINDS);
}

// OV nests memory files under date subdirectories (memories/<kind>/<date>/…),
// so descend until files are found (bounded).
async function walkDirs(ov, key, userId, dirs) {
  const out = [];
  const walk = async (uri, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await ov.listDir(key, uri);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDir) await walk(e.uri, depth + 1);
      else out.push(e);
    }
  };
  for (const kind of dirs) {
    await walk(`viking://user/${userId}/memories/${kind}`, 0);
  }
  return out;
}

function existingIn(list, key) {
  return list.some((s) => s.key === key);
}

function basename(uri) {
  const parts = String(uri).split('/');
  return parts[parts.length - 1] || uri;
}
