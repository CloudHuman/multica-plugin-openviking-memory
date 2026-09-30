import { cap, nowIso, readJsonIfExists, atomicWriteJson } from './util.mjs';
import { scopeKey } from './scopes.mjs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Shared-memory promotion: distil durable knowledge from the workspace's
 * agent-public and task-collaboration spaces into the workspace shared space.
 *
 * Writes go through OpenViking's NATIVE session→commit→extraction pipeline
 * (one session per run) — the same mechanism that makes agent-public memories
 * searchable — so promoted entries get real L0/L1 layers and semantic index
 * entries. Idempotency is tracked in {stateDir}/consolidated.json (file
 * basenames already promoted).
 */
const PROMOTABLE_KINDS = ['experiences', 'cases', 'preferences', 'entities'];

export async function consolidateShared({
  ov, registry, workspaceId, stateDir,
  perScopeLimit = 8, maxPerRun = 12, contentMinChars = 30, log = () => {},
}) {
  const sharedScope = scopeKey('shared', workspaceId);
  const shared = await registry.ensureScope(sharedScope, { workspaceId });
  const donePath = join(stateDir, 'consolidated.json');
  const done = readJsonIfExists(donePath, { files: {} });
  done.files ??= {};

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
      if (taken >= perScopeLimit || selected.length >= maxPerRun) break outer;
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
  const sessionId = `mc-consolidate-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const messages = selected.map((s, i) => ({
    role: 'user',
    message_kind: 'user_query',
    turn_id: `promote-${i}`,
    content: `【共享记忆晋升 #${i + 1}】来源范围: ${s.from}\n原文件: ${s.file}\n内容:\n${cap(s.content, 3500)}`,
  }));
  await ov.createSession(shared.apiKey, { sessionId, autoCommitPolicy: null });
  for (const chunk of chunkList(messages, 100)) {
    await ov.addMessages(shared.apiKey, sessionId, chunk);
  }
  const commit = await ov.commitSession(shared.apiKey, sessionId, {
    tags: ['source=multica-plugin', `workspace=${workspaceId}`, 'scope=shared', 'record=consolidate'],
  });
  for (const s of selected) done.files[s.key] = nowIso();
  atomicWriteJson(donePath, done);
  log(`consolidate: ${selected.length} memories queued for shared-space extraction (${sessionId})`);
  return {
    shared_scope: sharedScope,
    sources: sourceScopes.length,
    promoted: selected.map(({ file, from }) => ({ file, from })),
    session_id: sessionId,
    extraction_task: commit?.task_id ?? null,
  };
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

function chunkList(list, size) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  return chunks;
}
