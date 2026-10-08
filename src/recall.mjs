import { beforeDeadline } from './util.mjs';
import { memoryExcerpt, memoryFingerprint, promotionQuality } from './memory-quality.mjs';

/**
 * Multi-scope recall: fan out one search per authorized space key, then merge,
 * filter, rank and cap — preserving provenance so agents can verify sources.
 *
 * Quality rules (spec §2.2):
 *   - only distilled memories (context_type=memory) are candidates;
 *   - namespace stubs (.overview.md / .abstract.md) are dropped;
 *   - duplicates collapse: the same uri, or the same memory stored twice in one
 *     scope — OV files an event that involved a peer both under the user's
 *     memories/ and under peers/<peer>/memories/;
 *   - ranking: semantic score, tie-broken by scope priority (task > dm >
 *     delegation > run > automation > agent > shared);
 *   - cap at `entries` (default 5); each entry carries its source uri+scope.
 *
 * Time budget: a search embeds the query and reranks through the model
 * provider, and a slow provider can hold one past its hook's timeout. With a
 * `deadline` (epoch ms), scopes that have not answered by then are reported
 * as timed out and the rest are returned; entries whose content cannot be read
 * in time keep their abstract.
 */

const STUB_URI_RE = /\/\.(overview|abstract)\.md$/;
const PEER_COPY_RE = /\/peers\/[^/]+\/memories\//;

/** One key per memory, whichever copy (own or peer) a hit is: user-space URIs carry the user id. */
const memoryKey = (uri) => uri.replace(PEER_COPY_RE, '/memories/');
const isPeerCopy = (uri) => PEER_COPY_RE.test(uri);

const SCOPE_PRIORITY = {
  task: 0,
  dm: 1,
  delegation: 2,
  run: 3,
  automation: 4,
  agent: 5,
  shared: 6,
};

export function recallPriority(scopeKeyStr) {
  return SCOPE_PRIORITY[String(scopeKeyStr).split(':')[0]] ?? 9;
}

// Words that carry no business intent around an identifier, in English and Chinese.
const GENERIC_EN_RE = /\b(?:task|issue|id|context|related|memories|memory|and|or|for|of|the|a|an|about|on|in|to|with|this|that|any|all|prior|previous|decisions?|notes?|info(?:rmation)?|details?|background|history)\b/gi;
const GENERIC_ZH_RE = /任务|相关|记忆|上下文|背景|历史|之前|以前|先前|决策|决定|约定|信息|资料|内容|有关|关于|的|和|或|及|与/g;

/** A UUID plus generic search boilerplate contains no business search intent. */
export function isOpaqueMemoryQuery(query) {
  const text = String(query ?? '');
  const withoutIds = text.replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, '').replace(/\b[A-Z]{2,12}-\d+\b/g, '');
  return withoutIds !== text && !withoutIds.replace(GENERIC_EN_RE, '').replace(GENERIC_ZH_RE, '').replace(/[\s:,_\-.、，。：；;!?？！()（）]+/g, '');
}

// An identifier as a whole token: MUL-8 is not MUL-80, and UUIDs match in any case.
const identifierRe = (id, flags) => new RegExp(`(?<![A-Za-z0-9_-])${String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, flags);

/** Whether the query names any of these identifiers (issue UUID or key, task UUID). */
export function mentionsIdentifier(query, ids) {
  return ids.some((id) => id && identifierRe(id, 'i').test(String(query ?? '')));
}

/** The query with these identifiers removed; what is left is the caller's own wording. */
export function withoutIdentifiers(query, ids) {
  let text = String(query ?? '');
  for (const id of ids) if (id) text = text.replace(identifierRe(id, 'gi'), ' ');
  return text.replace(/\s+/g, ' ').trim();
}

export function issueMemoryQuery(issue) {
  const title = typeof issue?.title === 'string' ? issue.title.trim() : '';
  const description = typeof issue?.description === 'string' ? memoryExcerpt(issue.description).content : '';
  return [title, description].filter(Boolean).join('\n').slice(0, 600);
}

export async function recallFromScopes({
  ov, registry, scopeKeys, query, entries = 5, perScopeLimit = 10, contentMaxChars = 2400,
  deadline = Infinity, contentReserveMs = 1_500, onScopeError = () => {},
}) {
  // Reading the survivors is a plain file read; the searches get the rest.
  const searchDeadline = deadline - contentReserveMs;
  const searches = await Promise.all(
    scopeKeys.map(async (scopeKeyStr) => {
      const rec = registry.get(scopeKeyStr);
      if (!rec) return { scopeKeyStr, hits: [], skipped: 'not-provisioned' };
      try {
        const result = await beforeDeadline(
          ov.search(rec.apiKey, { query, limit: perScopeLimit, readContent: false, deadline: searchDeadline }),
          searchDeadline,
        );
        const hits = Array.isArray(result?.memories) ? result.memories : [];
        return { scopeKeyStr, hits };
      } catch (err) {
        // Past the deadline, whichever gave up first (the timer or the aborted request) means the same.
        if (err.code === 'deadline' || Date.now() >= searchDeadline) return { scopeKeyStr, hits: [], timedOut: true };
        onScopeError(scopeKeyStr, err);
        return { scopeKeyStr, hits: [], error: String(err.message ?? err) };
      }
    }),
  );

  const merged = new Map();
  for (const { scopeKeyStr, hits } of searches) {
    for (const hit of hits) {
      if (!hit || hit.context_type !== 'memory') continue;
      const uri = String(hit.uri ?? '');
      if (!uri || STUB_URI_RE.test(uri)) continue;
      const score = Number(hit.score ?? 0);
      const cand = {
        uri,
        level: hit.level,
        score,
        abstract: hit.abstract ?? '',
        scope: scopeKeyStr,
        priority: recallPriority(scopeKeyStr),
      };
      const key = memoryKey(uri);
      const prev = merged.get(key);
      const better = !prev || score > prev.score
        || (score === prev.score && (cand.priority < prev.priority || (isPeerCopy(prev.uri) && !isPeerCopy(uri))));
      if (better) merged.set(key, cand);
    }
  }

  // Read a bounded reserve so filtered controls/copies don't use up all slots.
  const candidates = [...merged.values()].sort((a, b) => b.score - a.score || a.priority - b.priority).slice(0, Math.min(30, entries * 3));

  // Attach L2 content for the survivors (best effort, per-own-space key).
  await Promise.all(
    candidates.map(async (entry) => {
      const rec = registry.get(entry.scope);
      if (!rec) return;
      try {
        const r = await beforeDeadline(ov.readContent(rec.apiKey, entry.uri, { limit: 400, deadline }), deadline);
        const content = typeof r?.content === 'string' ? r.content : undefined;
        if (content) entry.content = content;
      } catch {
        /* content is an enrichment, never a failure */
      }
    }),
  );

  const ranked = [];
  const byContent = new Map();
  for (const entry of candidates) {
    const evidence = entry.content ?? entry.abstract;
    if (entry.scope.startsWith('shared:') && !promotionQuality({ content: evidence, uri: entry.uri, maxContentChars: Infinity }).eligible) continue;
    const excerpt = memoryExcerpt(evidence, { uri: entry.uri });
    if (evidence && !excerpt.content) continue;
    if (entry.content) entry.content = excerpt.content;
    const abstract = memoryExcerpt(entry.abstract, { uri: entry.uri });
    entry.abstract = abstract.content;
    entry.contentFiltered = excerpt.filtered || abstract.filtered;
    // Tiny fallback summaries (or a failed read) are not sufficient evidence
    // that two files are the same. Keep such candidates separate.
    const fingerprint = entry.content?.length >= 30 ? memoryFingerprint(entry.content) : null;
    const previous = fingerprint && byContent.get(fingerprint);
    if (previous) {
      previous.duplicateSources ??= [];
      previous.duplicateSources.push({ uri: entry.uri, scope: entry.scope });
      continue;
    }
    if (ranked.length >= entries) continue;
    if (fingerprint) byContent.set(fingerprint, entry);
    if (entry.content?.length > contentMaxChars) entry.content = entry.content.slice(0, contentMaxChars);
    ranked.push(entry);
  }

  // Short facts first: Multica keeps only an 8 KB preview of a tool result in
  // the run's transcript, and which spaces were searched must survive it.
  return {
    query,
    scopesSearched: searches.map((s) => ({ scope: s.scopeKeyStr, hits: s.hits.length, skipped: s.skipped, error: s.error, timedOut: s.timedOut })),
    entries: ranked.map(({ uri, level, score, abstract, scope, content, contentFiltered, duplicateSources }) => ({
      uri,
      level,
      score: Math.round(score * 1000) / 1000,
      abstract,
      content: content ?? null,
      scope,
      source: uri,
      ...(contentFiltered ? { content_filtered: true } : {}),
      ...(duplicateSources ? { duplicate_sources: duplicateSources } : {}),
    })),
  };
}

/** Render recall entries as the compact injected-context block (for the companion injection API). */
export function renderRecallBlock(result, { maxChars = 6000 } = {}) {
  if (!result.entries.length) return '';
  const lines = ['[OpenViking memory recall — reference evidence, verify before relying on it]'];
  let used = lines[0].length;
  result.entries.forEach((e, i) => {
    const body = (e.content ?? e.abstract ?? '').trim();
    const block = `\n${i + 1}. [${e.scope}] ${e.uri}\n${body}`;
    if (used + block.length > maxChars) return;
    lines.push(block);
    used += block.length;
  });
  return lines.join('');
}
