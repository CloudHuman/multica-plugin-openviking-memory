#!/usr/bin/env node
/**
 * Offline manifest validation — re-implements the multica plugin-contract
 * rules that matter for packaging (so a bad zip never reaches the installer):
 *   - required fields, semver, reverse-DNS key, no unknown top-level fields
 *   - scopes drawn from the closed catalog (+ parameterized net:<domain>)
 *   - events drawn from the 7-event catalog; event hooks need the matching
 *     read scope; agent hooks are allowed on http transport
 *   - transport URLs must be HTTPS and their host exactly covered by a net: scope
 *   - skill resources: entry exactly skills/<key>/SKILL.md, ≤256KiB
 *   - referenced files exist inside the package
 */
import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCOPE_CATALOG = new Set([
  'issues:read', 'issues:write', 'comments:read', 'comments:write',
  'tasks:read', 'tasks:write', 'agents:read', 'members:read',
  'storage:user', 'storage:workspace',
]);
const EVENT_CATALOG = new Set([
  'issue.created', 'issue.updated', 'issue.status_changed',
  'comment.created', 'task.started', 'task.completed', 'task.failed',
]);
const EVENT_READ_SCOPE = {
  'issue.created': 'issues:read', 'issue.updated': 'issues:read', 'issue.status_changed': 'issues:read',
  'comment.created': 'comments:read',
  'task.started': 'tasks:read', 'task.completed': 'tasks:read', 'task.failed': 'tasks:read',
};
const TRIGGERS = new Set(['ui', 'manual', 'agent', 'event', 'schedule']);
const CONFIG_TYPES = new Set(['string', 'number', 'bool', 'enum', 'secret']);
const KNOWN_TOP = new Set([
  'manifest_version', 'key', 'name', 'description', 'version', 'author',
  'icon', 'scopes', 'config', 'contributes',
]);
const MAX_SKILL_BYTES = 256 * 1024;

export function validateManifest(json, { baseDir } = {}) {
  const errors = [];
  const push = (m) => errors.push(m);

  for (const k of Object.keys(json)) {
    if (!KNOWN_TOP.has(k)) push(`unknown top-level field "${k}" (multica rejects with 400)`);
  }
  if (json.manifest_version !== 1) push('manifest_version must be 1');
  if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/.test(String(json.key ?? ''))) {
    push(`key "${json.key}" is not reverse-DNS with ≥2 segments`);
  }
  for (const seg of String(json.key ?? '').split('.')) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(seg)) push(`key segment "${seg}" violates [a-z][a-z0-9-]* pattern`);
  }
  if (!json.name || String(json.name).length > 160) push('name required, ≤160 bytes');
  if (json.description && String(json.description).length > 2000) push('description ≤2000 bytes');
  if (!/^\d+\.\d+\.\d+[-+0-9A-Za-z.-]*$/.test(String(json.version ?? ''))) push(`version "${json.version}" is not full semver`);
  if (!json.author?.name) push('author.name required');
  if (json.author?.url && !String(json.author.url).startsWith('https://')) push('author.url must be HTTPS');

  const scopes = Array.isArray(json.scopes) ? json.scopes : [];
  if (!scopes.length || scopes.length > 64) push('scopes: 1-64 entries required');
  if (new Set(scopes).size !== scopes.length) push('scopes contain duplicates');
  const netDomains = new Set();
  for (const s of scopes) {
    if (s.startsWith('net:')) {
      const d = s.slice(4);
      if (!/^[a-z0-9.-]+$/i.test(d) || d.length > 253) push(`net scope domain invalid: ${d}`);
      netDomains.add(d.toLowerCase());
    } else if (!SCOPE_CATALOG.has(s)) {
      push(`scope "${s}" not in the closed catalog`);
    }
  }

  const config = json.config ?? {};
  if (typeof config !== 'object' || Array.isArray(config)) push('config must be an object keyed by field key');
  const configKeys = Object.keys(config);
  if (configKeys.length > 32) push('config: at most 32 fields');
  for (const [k, f] of Object.entries(config)) {
    if (!CONFIG_TYPES.has(f?.type)) push(`config.${k}: unknown type "${f?.type}"`);
    if (f?.type === 'enum') {
      if (!Array.isArray(f.options) || f.options.length < 1 || f.options.length > 64) push(`config.${k}: enum needs 1-64 options`);
    } else if (f?.options !== undefined) push(`config.${k}: options only allowed on enum`);
    if (f?.multiline && f?.type !== 'string') push(`config.${k}: multiline only on string`);
  }

  const c = json.contributes ?? {};
  const total = (c.hooks?.length ?? 0) + (c.surfaces?.length ?? 0) + (c.resources?.length ?? 0);
  if (total < 1 || total > 64) push('contributes: 1-64 entries required');

  const hookKeys = new Set();
  for (const h of c.hooks ?? []) {
    if (!h.key) push('hook.key required');
    if (hookKeys.has(h.key)) push(`duplicate hook key ${h.key}`);
    hookKeys.add(h.key);
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(String(h.key ?? ''))) push(`hook key "${h.key}" pattern invalid`);
    const triggers = h.triggers ?? [];
    for (const t of triggers) if (!TRIGGERS.has(t)) push(`hook ${h.key}: unknown trigger ${t}`);
    if (triggers.includes('event')) {
      const events = h.events ?? [];
      if (!events.length) push(`hook ${h.key}: event trigger needs events`);
      for (const e of events) {
        if (!EVENT_CATALOG.has(e)) push(`hook ${h.key}: unknown event ${e}`);
        const need = EVENT_READ_SCOPE[e];
        if (need && !scopes.includes(need)) push(`hook ${h.key}: event ${e} requires scope ${need}`);
      }
    }
    if (triggers.includes('schedule')) {
      if (!h.schedule?.cron || !h.schedule?.timezone) push(`hook ${h.key}: schedule needs cron+timezone`);
    }
    const t = h.transport ?? {};
    if (!['http', 'mcp'].includes(t.type)) push(`hook ${h.key}: transport type must be http|mcp`);
    let host = '';
    try {
      const u = new URL(t.url ?? '');
      if (u.protocol !== 'https:') push(`hook ${h.key}: transport URL must be HTTPS`);
      if (u.username || u.search || u.hash) push(`hook ${h.key}: transport URL must be plain (no userinfo/query/fragment)`);
      host = u.hostname.toLowerCase();
    } catch {
      push(`hook ${h.key}: transport URL invalid (${t.url})`);
    }
    if (host && !netDomains.has(host)) {
      push(`hook ${h.key}: transport host "${host}" not exactly covered by a net: scope`);
    }
    const to = h.timeout_ms ?? 10_000;
    if (to < 100 || to > 30_000) push(`hook ${h.key}: timeout_ms must be 100..30000`);
  }

  for (const r of c.resources ?? []) {
    if (r.type !== 'skill') push(`resource type must be skill (got ${r.type})`);
    if (!/^skills\/[a-z0-9-]+\/SKILL\.md$/.test(r.entry ?? '')) push(`resource entry must be skills/<key>/SKILL.md (got ${r.entry})`);
    if (baseDir) {
      const p = resolve(baseDir, r.entry ?? '');
      if (!existsSync(p)) push(`resource file missing: ${r.entry}`);
      else if (statSync(p).size > MAX_SKILL_BYTES) push(`resource ${r.entry} exceeds 256KiB`);
    }
  }

  if (baseDir && json.icon) {
    if (!existsSync(resolve(baseDir, json.icon))) push(`icon missing: ${json.icon}`);
  }
  return errors;
}

const manifestPath = process.argv[2];
if (manifestPath) {
  const baseDir = dirname(resolve(manifestPath));
  const json = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const errors = validateManifest(json, { baseDir });
  if (errors.length) {
    console.error('manifest INVALID:');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  console.log(`manifest OK: ${json.key} v${json.version} (${(json.contributes?.hooks?.length ?? 0)} hooks, ${(json.contributes?.resources?.length ?? 0)} resources)`);
}

export { MAX_SKILL_BYTES };
