import { cap, nowIso } from './util.mjs';
import { scopeKey } from './scopes.mjs';

/**
 * Shared-memory promotion: distil durable knowledge from the workspace's
 * agent-public and task-collaboration spaces into the workspace shared space,
 * so the shared scope agents read on every recall actually carries content.
 *
 * Selection: the reusable kinds (experiences / cases / preferences /
 * entities) — events are run noise by design. Idempotent per file basename;
 * provenance is preserved in frontmatter (promoted_from carries the source
 * scope, so attribution survives promotion).
 */
const PROMOTABLE_KINDS = ['experiences', 'cases', 'preferences', 'entities'];

export async function consolidateShared({
  ov, registry, workspaceId,
  perScopeLimit = 8, maxPerRun = 30, contentMinChars = 30, log = () => {},
}) {
  const sharedScope = scopeKey('shared', workspaceId);
  const shared = await registry.ensureScope(sharedScope, { workspaceId });

  const existing = new Set();
  for (const entry of await walkDirs(ov, shared.apiKey, shared.userId, [...PROMOTABLE_KINDS, 'shared'])) {
    existing.add(basename(entry.uri));
  }

  const sourceScopes = Object.keys(registry.data.scopes).filter(
    (k) => k.startsWith(`agent:${workspaceId}:`) || k.startsWith(`task:${workspaceId}:`),
  );
  const promoted = [];
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
      if (taken >= perScopeLimit || promoted.length >= maxPerRun) break outer;
      const base = basename(f.uri);
      if (existing.has(base)) continue;
      let content;
      try {
        const r = await ov.readContent(rec.apiKey, f.uri, { limit: 400 });
        content = r?.content;
      } catch { continue; }
      if (!content || content.length < contentMinChars) continue;
      const targetUri = `viking://user/${shared.userId}/memories/shared/${base}`;
      const body = [
        '---',
        `title: ${base.replace(/\.md$/, '')}`,
        `promoted_at: ${nowIso()}`,
        `promoted_from: ${scopeKeyStr}`,
        'origin: multica-shared-consolidate',
        '---',
        '',
        cap(content, 4000),
        '',
      ].join('\n');
      try {
        await ov.writeContent(shared.apiKey, { uri: targetUri, content: body, mode: 'create' });
        await ov.reindex(shared.apiKey, targetUri).catch(() => {});
      } catch (err) {
        log(`consolidate: write ${base} failed (${err.message})`);
        continue;
      }
      existing.add(base);
      promoted.push({ from: scopeKeyStr, file: base });
      taken++;
    }
  }
  log(`consolidate: ${promoted.length} memories promoted from ${sourceScopes.length} scopes into ${sharedScope}`);
  return { shared_scope: sharedScope, sources: sourceScopes.length, promoted };
}

async function walkKinds(ov, key, userId) {
  return walkDirs(ov, key, userId, PROMOTABLE_KINDS);
}

async function walkDirs(ov, key, userId, dirs) {
  const out = [];
  for (const kind of dirs) {
    const entries = await ov.listDir(key, `viking://user/${userId}/memories/${kind}`);
    out.push(...entries.filter((e) => !e.isDir));
  }
  return out;
}

function basename(uri) {
  const parts = String(uri).split('/');
  return parts[parts.length - 1] || uri;
}
