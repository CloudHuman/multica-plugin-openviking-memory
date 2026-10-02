import { createHash } from 'node:crypto';
import { nowIso } from './util.mjs';

/**
 * Per-workspace memory extraction rules.
 *
 * Each multica workspace has its own OpenViking account. A workspace admin may
 * add extraction guidance through the installation's `memory_rules` config; the
 * plugin writes it into that account's memory templates through OpenViking's
 * own admin API (account-level templates), so it changes extraction for that
 * workspace only. Without rules OpenViking's native templates apply, and
 * templates the plugin did not write are never touched.
 *
 * OpenViking 0.4.22 opens profile, events, preferences, entities, soul and
 * identity to account edits, and only their descriptions; soul and identity
 * are the agent's bootstrap personality, outside business-memory rules. A rule
 * is appended to the native description and never replaces it.
 */

export const ACCOUNT_TEMPLATE_TYPES = ['profile', 'events', 'preferences', 'entities'];
// General rules are written once, under entities: its schema is in every
// extraction prompt and is the only one in OpenViking's entity follow-up prompt.
export const COMMON_RULES_TYPE = 'entities';
export const WORKSPACE_RULES_HEADING = '## Workspace memory rules';
const POINTER = `Also apply the general rules listed under this heading in the ${COMMON_RULES_TYPE} memory type.`;
const TYPE_PREFIX = new RegExp(`^(${ACCOUNT_TEMPLATE_TYPES.join('|')})\\s*[:：]\\s*`, 'i');
// OpenViking renders descriptions as restricted Jinja: rules must be plain text.
const TEMPLATE_SYNTAX = /\{\{|\{%|\{#/;
const MAX_RULE_CHARS = 1000;
const RETRY_AFTER_ERROR_MS = 10 * 60_000;

/**
 * One rule per line. `entities:` / `events:` / `preferences:` / `profile:`
 * scope a line to one memory type; other lines apply to all. Blank lines and
 * `#` comments are ignored; a leading list marker is dropped.
 */
export function parseMemoryRules(text) {
  const rules = { common: [], types: {} };
  const errors = [];
  let count = 0;
  for (const [i, raw] of String(text ?? '').split(/\r?\n/).entries()) {
    let line = raw.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '');
    if (!line || line.startsWith('#')) continue;
    if (TEMPLATE_SYNTAX.test(line)) { errors.push(`line ${i + 1}: template syntax ({{, {%, {#) is not allowed`); continue; }
    if (line.length > MAX_RULE_CHARS) { errors.push(`line ${i + 1}: longer than ${MAX_RULE_CHARS} characters`); continue; }
    const prefix = line.match(TYPE_PREFIX);
    if (prefix) {
      line = line.slice(prefix[0].length).trim();
      if (!line) continue;
      (rules.types[prefix[1].toLowerCase()] ??= []).push(line);
    } else {
      rules.common.push(line);
    }
    count++;
  }
  return { rules, errors, count };
}

/**
 * The template body for one type: the rules appended to OpenViking's default
 * descriptions; everything else stays OpenViking's default. `null` when the
 * type gets no rule. `rules.fields` (optional) adds lines to field descriptions.
 */
export function accountTemplate(defaults, rules, { heading = WORKSPACE_RULES_HEADING } = {}) {
  const kind = defaults.memory_type;
  const typeRules = rules.types?.[kind] ?? [];
  const common = rules.common ?? [];
  const lines = kind === COMMON_RULES_TYPE ? [...common, ...typeRules] : [...(common.length ? [POINTER] : []), ...typeRules];
  const fields = (defaults.fields ?? []).flatMap((field) => {
    const extra = [...(field.name === 'content' ? typeRules : []), ...(rules.fields?.[kind]?.[field.name] ?? [])];
    return extra.length ? [{ name: field.name, description: `${field.description ?? ''}\n${extra.join('\n')}` }] : [];
  });
  if (!lines.length && !fields.length) return null;
  return {
    description: lines.length ? `${defaults.description ?? ''}\n\n${heading}\n${lines.map((rule) => `- ${rule}`).join('\n')}` : defaults.description ?? '',
    ...(fields.length ? { fields } : {}),
  };
}

const templatePath = (accountId, kind) => `/api/v1/admin/accounts/${encodeURIComponent(accountId)}/memory-templates/${kind}`;
const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/**
 * Publish rules as account templates with a key allowed to manage the account
 * (its admin key, or root). A type without rules is reset to OpenViking's
 * default only when listed in `resetTypes` (types this writer published before).
 */
export async function writeAccountTemplates({ ov, key, accountId, rules, heading = WORKSPACE_RULES_HEADING, resetTypes = [] }) {
  const published = [];
  try {
    for (const kind of ACCOUNT_TEMPLATE_TYPES) {
      const { defaults } = await ov.call(templatePath(accountId, kind), { key });
      const body = accountTemplate(defaults, rules, { heading });
      if (!body) {
        if (resetTypes.includes(kind)) await ov.call(templatePath(accountId, kind), { method: 'DELETE', key });
        continue;
      }
      const result = await ov.call(templatePath(accountId, kind), { method: 'PUT', key, body });
      if (result?.status !== 'custom' || !JSON.stringify(result.effective ?? {}).includes(JSON.stringify(heading).slice(1, -1))) {
        throw new Error(`OpenViking did not keep the account memory template for ${kind}`);
      }
      published.push({ kind, body });
    }
  } catch (err) {
    err.publishedTypes = published.map((p) => p.kind);
    throw err;
  }
  return { memoryTypes: published.map((p) => p.kind), digest: digestOf(published) };
}

/** Back to OpenViking's defaults. Memories already extracted are not rewritten. */
export async function resetAccountTemplates({ ov, key, accountId, types = ACCOUNT_TEMPLATE_TYPES }) {
  for (const kind of types) await ov.call(templatePath(accountId, kind), { method: 'DELETE', key });
}

/**
 * Keeps each workspace's account templates in line with its configured rules.
 * The applied state lives with the account in the scope registry.
 */
export class WorkspaceMemoryRules {
  constructor({ ov, registry, log = () => {} }) {
    this.ov = ov;
    this.registry = registry;
    this.log = log;
    this.chains = new Map(); // workspaceId -> last apply, so changes land in order
  }

  /**
   * `text` is the installation's memory_rules as delivered with a hook call:
   * undefined when the call carried no config (leave everything as it is).
   * Never throws: extraction proceeds with whatever templates are in place.
   */
  ensure(workspaceId, text) {
    if (text === undefined || !workspaceId) return Promise.resolve(null);
    const previous = this.chains.get(workspaceId) ?? Promise.resolve();
    const run = previous.then(() => this.#apply(workspaceId, text)).catch((err) => {
      this.log(`memory rules for workspace ${workspaceId} not applied: ${err.message}`);
      return null;
    });
    this.chains.set(workspaceId, run);
    return run;
  }

  /** Resolves once every rules update queued for this workspace has finished. */
  settled(workspaceId) {
    return this.chains.get(workspaceId) ?? Promise.resolve(null);
  }

  /** Public status for one workspace (no rule text, no keys). */
  status(workspaceId) {
    const account = Object.values(this.registry.data.accounts ?? {}).find((a) => a.workspaceId === workspaceId);
    const state = account?.memoryRules;
    if (!state) return { status: 'default' };
    const { status, rules, memoryTypes, digest, updatedAt, error } = state;
    return { status, rules, memory_types: memoryTypes, digest, updated_at: updatedAt, ...(error ? { error } : {}) };
  }

  async #apply(workspaceId, text) {
    const parsed = parseMemoryRules(text);
    const source = parsed.count ? digestOf(parsed.rules) : '';
    const { accountId, adminKey } = await this.registry.ensureAccount(workspaceId);
    const account = this.registry.data.accounts[accountId];
    const previous = account.memoryRules;
    const settled = previous && previous.source === source && !['error', 'invalid'].includes(previous.status);
    if (settled || (!previous && !source && !parsed.errors.length)) return previous ?? null;
    if (previous?.source === source && previous.status === 'error' && Date.now() - Date.parse(previous.updatedAt) < RETRY_AFTER_ERROR_MS) return previous;
    const save = (state) => {
      account.memoryRules = { ...state, updatedAt: nowIso() };
      this.registry.save();
      return account.memoryRules;
    };
    if (parsed.errors.length) {
      // Keep whatever is published; a fixed config applies on the next delivery.
      const error = parsed.errors.join('; ');
      if (previous?.status === 'invalid' && previous.error === error) return previous;
      return save({ ...(previous ?? { source: '', memoryTypes: [] }), status: 'invalid', error });
    }
    const written = previous?.memoryTypes ?? [];
    try {
      if (!source) {
        if (written.length) await resetAccountTemplates({ ov: this.ov, key: adminKey, accountId, types: written });
        this.log(`memory rules cleared for workspace ${workspaceId}: OpenViking defaults`);
        return save({ status: 'default', source: '', rules: 0, memoryTypes: [] });
      }
      const result = await writeAccountTemplates({ ov: this.ov, key: adminKey, accountId, rules: parsed.rules, resetTypes: written });
      this.log(`memory rules applied for workspace ${workspaceId}: ${parsed.count} rule(s) on ${result.memoryTypes.join(', ')}`);
      return save({ status: 'applied', source, rules: parsed.count, memoryTypes: result.memoryTypes, digest: result.digest });
    } catch (err) {
      // A partial write leaves some types published: list them so a later clear
      // still resets them, and retry after a pause.
      save({ ...(previous ?? {}), status: 'error', source, memoryTypes: [...new Set([...written, ...(err.publishedTypes ?? [])])], error: String(err.message ?? err).slice(0, 300) });
      throw err;
    }
  }
}
