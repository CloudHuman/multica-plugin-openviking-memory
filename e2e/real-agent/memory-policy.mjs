// Account-level OpenViking memory templates for tests. The plugin never sets
// these: they are written only to a test workspace's OV account through
// OpenViking's own admin API, so the instance templates and every other
// account keep OV's native extraction.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { OvClient } from '../../src/ov-client.mjs';
import { accountIdFor, adminUserIdFor } from '../../src/scopes.mjs';

// OpenViking 0.4.22 opens only profile, events, preferences, entities, soul and
// identity to account edits; soul and identity are the agent's bootstrap
// personality, outside a business-memory policy.
export const ACCOUNT_POLICY_TYPES = ['profile', 'events', 'preferences', 'entities'];
export const POLICY_HEADING = '## Multica business-memory quality';
// The common rules are written once, under entities: its schema is in every
// extraction prompt and is the only one in OV's entity follow-up prompt.
export const COMMON_RULES_TYPE = 'entities';
const COMMON_RULES_POINTER = `Also apply the general Multica business-memory rules listed under the ${COMMON_RULES_TYPE} memory type.`;

export function loadMemoryPolicy(path = new URL('./memory-policy.json', import.meta.url)) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The PUT body for one type: the policy appended to OV's default descriptions; everything else stays OV's default. */
export function accountTemplate(defaults, policy) {
  const kind = defaults.memory_type;
  const typeRules = policy.types?.[kind] ?? [];
  const rules = [...(kind === COMMON_RULES_TYPE ? policy.common : [COMMON_RULES_POINTER]), ...typeRules];
  const fields = (defaults.fields ?? []).flatMap((field) => {
    const extra = [...(field.name === 'content' ? typeRules : []), ...(policy.fields?.[kind]?.[field.name] ?? [])];
    return extra.length ? [{ name: field.name, description: `${field.description ?? ''}\n${extra.join('\n')}` }] : [];
  });
  return {
    description: `${defaults.description ?? ''}\n\n${POLICY_HEADING}\n${rules.map((rule) => `- ${rule}`).join('\n')}`,
    ...(fields.length ? { fields } : {}),
  };
}

const templatePath = (accountId, kind) => `/api/v1/admin/accounts/${encodeURIComponent(accountId)}/memory-templates/${kind}`;

/**
 * Publish the policy as account templates. Given a workspace, the account is
 * created first under the plugin's deterministic IDs, so extraction uses the
 * templates from the first commit; the plugin then finds the account and mints
 * its admin key as it does for any existing account.
 */
export async function applyAccountMemoryPolicy({ ov, rootKey, workspaceId, accountId = workspaceId && accountIdFor(workspaceId), policy = loadMemoryPolicy() }) {
  if (!accountId) throw new Error('A workspace or account ID is required');
  if (workspaceId) await ov.createAccount(rootKey, { accountId, adminUserId: adminUserIdFor(workspaceId) });
  const bodies = [];
  for (const kind of ACCOUNT_POLICY_TYPES) {
    const { defaults } = await ov.call(templatePath(accountId, kind), { key: rootKey });
    const body = accountTemplate(defaults, policy);
    const published = await ov.call(templatePath(accountId, kind), { method: 'PUT', key: rootKey, body });
    if (published?.status !== 'custom' || !published.effective?.description?.includes(POLICY_HEADING)) {
      throw new Error(`OpenViking did not keep the account memory template for ${kind}`);
    }
    bodies.push(body);
  }
  // Identifies what was published (rules and how they were placed), not just the rules file.
  const digest = createHash('sha256').update(JSON.stringify(bodies)).digest('hex').slice(0, 16);
  return { scope: 'account', accountId, memoryTypes: ACCOUNT_POLICY_TYPES, digest };
}

/**
 * Create a test workspace's OV account before the plugin first sees it, in
 * either mode, so native and account runs reach extraction the same way and
 * differ only in templates. Fails before any model call when the instance
 * defaults already carry this policy (a leftover memory.custom_templates_dir),
 * since a native run would then not be native.
 */
export async function prepareTestAccount({ ov, rootKey, workspaceId, mode, policy = loadMemoryPolicy() }) {
  const accountId = accountIdFor(workspaceId);
  await ov.createAccount(rootKey, { accountId, adminUserId: adminUserIdFor(workspaceId) });
  for (const kind of ACCOUNT_POLICY_TYPES) {
    const { defaults } = await ov.call(templatePath(accountId, kind), { key: rootKey });
    if (JSON.stringify(defaults).includes(POLICY_HEADING)) {
      throw new Error(`OpenViking's instance templates already carry the Multica policy (${kind}); remove memory.custom_templates_dir and restart OV`);
    }
  }
  return mode === 'account' ? applyAccountMemoryPolicy({ ov, rootKey, accountId, policy }) : { scope: 'native', accountId };
}

/** Remove the overrides. Memories already extracted are not rewritten. */
export async function resetAccountMemoryPolicy({ ov, rootKey, accountId }) {
  for (const kind of ACCOUNT_POLICY_TYPES) await ov.call(templatePath(accountId, kind), { method: 'DELETE', key: rootKey });
  return { scope: 'native', accountId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const option = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const workspaceId = option('--workspace');
  const accountId = option('--account') ?? (workspaceId && accountIdFor(workspaceId));
  if (!accountId || !process.env.OV_ROOT_KEY) {
    console.error('usage: OV_ROOT_KEY=… [OV_BASE=http://127.0.0.1:1936] node e2e/real-agent/memory-policy.mjs (--workspace <Multica workspace ID> | --account <OV account ID>) [--reset]');
    process.exit(2);
  }
  const ov = new OvClient({ baseUrl: process.env.OV_BASE ?? 'http://127.0.0.1:1936' });
  const rootKey = process.env.OV_ROOT_KEY;
  const result = args.includes('--reset')
    ? await resetAccountMemoryPolicy({ ov, rootKey, accountId })
    : await applyAccountMemoryPolicy({ ov, rootKey, workspaceId, accountId });
  console.log(JSON.stringify(result));
}
