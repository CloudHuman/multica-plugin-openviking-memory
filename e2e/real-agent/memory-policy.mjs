// Account-level OpenViking memory templates for tests: the full rule set in
// memory-policy.json, written straight to a test workspace's OV account through
// OpenViking's own admin API. A workspace's own rules reach the plugin through
// its installation config (src/memory-rules.mjs, whose template builder this
// shares); this tool carries the larger test set, which exceeds multica's 4 KB
// config value. Instance templates and every other account keep OV's defaults.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { OvClient } from '../../src/ov-client.mjs';
import { accountIdFor, adminUserIdFor } from '../../src/scopes.mjs';
import { ACCOUNT_TEMPLATE_TYPES, COMMON_RULES_TYPE, accountTemplate as buildTemplate, resetAccountTemplates, writeAccountTemplates } from '../../src/memory-rules.mjs';

export const ACCOUNT_POLICY_TYPES = ACCOUNT_TEMPLATE_TYPES;
export const POLICY_HEADING = '## Multica business-memory quality';
export { COMMON_RULES_TYPE };

export function loadMemoryPolicy(path = new URL('./memory-policy.json', import.meta.url)) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The PUT body for one type: the policy appended to OV's default descriptions; everything else stays OV's default. */
export function accountTemplate(defaults, policy) {
  return buildTemplate(defaults, policy, { heading: POLICY_HEADING });
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
  // The digest identifies what was published (rules and how they were placed).
  const { memoryTypes, digest } = await writeAccountTemplates({ ov, key: rootKey, accountId, rules: policy, heading: POLICY_HEADING });
  return { scope: 'account', accountId, memoryTypes, digest };
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
  await resetAccountTemplates({ ov, key: rootKey, accountId });
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
