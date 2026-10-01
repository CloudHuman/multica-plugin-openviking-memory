import { nowIso, readJsonIfExists, atomicWriteJson, shortHash } from './util.mjs';
import { scopeKey } from './scopes.mjs';
import { join } from 'node:path';
import { listMemoryFiles } from './memory-inventory.mjs';
import { memoryFingerprint, promotionQuality } from './memory-quality.mjs';

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
  done.fingerprints ??= {};
  // Enqueue is authoritative if writing the separate receipt file failed.
  // Recover its keys before selecting a batch that may now include new files.
  let recovered = false;
  for (const job of queue.jobs.values()) {
    if (job.type !== 'consolidate' || job.payload.workspaceId !== workspaceId) continue;
    for (const source of job.payload.promotedSources ?? []) {
      const previous = done.files[source.key];
      if (previous?.hash !== source.hash && (!previous || String(previous.promoted_at ?? previous) <= job.created_at)) {
        done.files[source.key] = { hash: source.hash, revision: source.revision ?? 1, promoted_at: job.created_at };
        done.fingerprints[`${workspaceId}|${source.hash}`] = job.created_at;
        recovered = true;
      }
    }
    for (const key of job.payload.promotedKeys ?? []) if (!done.files[key]) {
      done.files[key] = job.created_at; recovered = true;
    }
  }
  if (recovered) atomicWriteJson(donePath, done);

  const sourceScopes = Object.keys(registry.data.scopes).filter(
    (k) => k.startsWith(`agent:${workspaceId}:`) || k.startsWith(`task:${workspaceId}:`),
  );

  const selected = [];
  const skipped = [];
  const receipts = [];
  // Promotion copies agent-public and task memories into the space every agent
  // in the workspace reads; the skill tells agents this can happen.
  outer: for (const scopeKeyStr of sourceScopes) {
    const rec = registry.get(scopeKeyStr);
    if (!rec) continue;
    let files;
    try {
      const inventory = await listMemoryFiles({ ov, key: rec.apiKey, userId: rec.userId, includePeers: false, kinds: PROMOTABLE_KINDS });
      if (!inventory.complete) throw new Error(`incomplete memory inventory: ${inventory.errors[0]?.reason}`);
      files = inventory.files;
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
      if (existingIn(selected, doneKey)) continue;
      let content;
      try {
        const r = await ov.readContent(rec.apiKey, f.uri, { limit: 400 });
        content = r?.content;
      } catch { continue; }
      if (!content || content.length < contentMinChars) continue;
      const quality = promotionQuality({ content, uri: f.uri });
      if (!quality.eligible) { skipped.push({ from: scopeKeyStr, file: base, reasons: quality.reasons }); continue; }
      const hash = memoryFingerprint(content);
      const previous = done.files[doneKey] ?? done.files[base];
      // An old URI-only receipt cannot prove which content was promoted. Admit
      // its current safe content once, then track the content version normally.
      if (previous?.hash === hash) continue;
      const revision = (Number(previous?.revision) || 0) + 1;
      if ((!previous && done.fingerprints[`${workspaceId}|${hash}`]) || selected.some(s => s.hash === hash)) {
        receipts.push({ key: doneKey, hash, revision, promoted_at: nowIso() });
        skipped.push({ from: scopeKeyStr, file: base, reasons: ['duplicate-content'] });
        continue;
      }
      selected.push({ from: scopeKeyStr, file: base, key: doneKey, uri: f.uri, hash, revision, updated: !!previous, content });
      taken++;
    }
  }

  if (!selected.length) {
    for (const receipt of receipts) {
      done.files[receipt.key] = { hash: receipt.hash, revision: receipt.revision, promoted_at: receipt.promoted_at };
      done.fingerprints[`${workspaceId}|${receipt.hash}`] = receipt.promoted_at;
    }
    if (receipts.length) atomicWriteJson(donePath, done);
    return { shared_scope: sharedScope, sources: sourceScopes.length, promoted: [], skipped, note: 'nothing new to promote' };
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
    content: `【共享记忆晋升 #${i + 1}】来源范围: ${s.from}\n原文件: ${s.file}\n来源 URI: ${s.uri}\n${s.updated ? '来源版本：已有来源文件更新后的当前内容；历史版本保留在原范围。\n' : ''}内容:\n${s.content}`,
  }));
  // Duplicate receipts join the same durable job: a failed receipt write or
  // process crash cannot cause those copies to be promoted in the next batch.
  const promotedSources = [...selected, ...receipts].map(({ key, hash, revision }) => ({ key, hash, revision }));
  const job = enqueuePromotion({ queue, workspaceId, sharedScope, sessionId, messages, promotedKeys: promotedSources.map(s => s.key), promotedSources });
  for (const source of promotedSources) {
    done.files[source.key] = { hash: source.hash, revision: source.revision, promoted_at: job.created_at };
    done.fingerprints[`${workspaceId}|${source.hash}`] = job.created_at;
  }
  atomicWriteJson(donePath, done);
  log(`consolidate: ${selected.length} memories durably queued for shared-space extraction (${sessionId})`);
  return {
    shared_scope: sharedScope,
    sources: sourceScopes.length,
    promoted: selected.map(({ file, from }) => ({ file, from })),
    skipped,
    session_id: sessionId,
    status: 'queued', job_id: job.id, extraction_task: null,
  };
}

function enqueuePromotion({ queue, workspaceId, sharedScope, sessionId, messages, promotedKeys = [], promotedSources = [] }) {
  return queue.enqueue('consolidate', {
    workspaceId, scopeKey: sharedScope, refId: sessionId, sessionId, messages, promotedKeys, promotedSources,
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

function existingIn(list, key) {
  return list.some((s) => s.key === key);
}

function basename(uri) {
  const parts = String(uri).split('/');
  return parts[parts.length - 1] || uri;
}
