import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_POLICY_TYPES, COMMON_RULES_TYPE, POLICY_HEADING, accountTemplate, applyAccountMemoryPolicy, inspectAccountTemplates, loadMemoryPolicy, loadMemoryRules, prepareTestAccount, resetAccountMemoryPolicy } from '../e2e/real-agent/memory-policy.mjs';
import { WORKSPACE_RULES_HEADING, parseMemoryRules, writeAccountTemplates } from '../src/memory-rules.mjs';
import { accountIdFor, adminUserIdFor } from '../src/scopes.mjs';

const policy = loadMemoryPolicy();
// Field names of OpenViking 0.4.22's bundled templates.
const NATIVE_FIELDS = { profile: ['content'], events: ['event_name', 'goal', 'summary', 'ranges'], preferences: ['user', 'topic', 'content'], entities: ['category', 'name', 'content'] };
const native = (kind) => ({
  memory_type: kind, description: `native ${kind}`, directory: `viking://user/{{ user_space }}/memories/${kind}`, enabled: true,
  fields: NATIVE_FIELDS[kind].map((name) => ({ name, type: 'string', description: `native ${name}`, merge_op: 'patch' })),
});

test('account templates only append the policy to descriptions', () => {
  const entities = accountTemplate(native('entities'), policy);
  assert.deepEqual(Object.keys(entities), ['description', 'fields']);
  assert.ok(entities.description.startsWith(`native entities\n\n${POLICY_HEADING}\n- `));
  for (const rule of [...policy.common, ...policy.types.entities]) assert.ok(entities.description.includes(`- ${rule}`));
  assert.deepEqual(entities.fields.map((f) => f.name), ['category', 'name', 'content']);
  for (const field of entities.fields) {
    assert.deepEqual(Object.keys(field), ['name', 'description']);
    assert.ok(field.description.startsWith(`native ${field.name}\n`));
  }
  assert.ok(entities.fields[2].description.endsWith(policy.types.entities.join('\n')));
  // Type rules also on the content field when the type has one.
  assert.deepEqual(accountTemplate(native('preferences'), policy).fields.map((f) => f.name), ['content']);
  assert.deepEqual(Object.keys(accountTemplate(native('events'), policy)), ['description']);
  assert.deepEqual(Object.keys(accountTemplate(native('profile'), policy)), ['description']);
});

test('the common rules reach the prompt once, under entities', () => {
  const templates = Object.fromEntries(ACCOUNT_POLICY_TYPES.map((kind) => [kind, JSON.stringify(accountTemplate(native(kind), policy))]));
  for (const rule of policy.common) {
    assert.deepEqual(ACCOUNT_POLICY_TYPES.filter((kind) => templates[kind].includes(JSON.stringify(rule).slice(1, -1))), [COMMON_RULES_TYPE]);
  }
  for (const kind of ACCOUNT_POLICY_TYPES.filter((k) => k !== COMMON_RULES_TYPE)) {
    const { description } = accountTemplate(native(kind), policy);
    assert.ok(description.startsWith(`native ${kind}\n\n${POLICY_HEADING}\n- Also apply the general rules listed under this heading in the entities memory type.`));
    for (const rule of policy.types[kind] ?? []) assert.ok(description.includes(`- ${rule}`));
  }
});

test('the policy is plain text for account-editable types and carries no test answers', () => {
  const text = JSON.stringify(policy);
  // OpenViking renders descriptions as restricted Jinja; plain text stays verbatim.
  assert.doesNotMatch(text, /\{\{|\{%|\{#/);
  assert.deepEqual([...Object.keys(policy.types), ...Object.keys(policy.fields)].filter((kind) => !ACCOUNT_POLICY_TYPES.includes(kind)), []);
  // The suites' own values (budget 7600→8100, RAM-n keys, weekly-report and comment-language preferences).
  assert.doesNotMatch(text, /7600|8100|RAM-\d|周报|注释|weekly|Chinese/i);
});

test('the config-mode rules fit the installation field, parse cleanly and carry no test answers', () => {
  const text = loadMemoryRules();
  // multica stores a string config value of at most 4096 bytes.
  assert.ok(Buffer.byteLength(text) <= 4096, `${Buffer.byteLength(text)} bytes`);
  const { rules, errors, count } = parseMemoryRules(text);
  assert.deepEqual(errors, []);
  assert.ok(rules.common.length > 0 && count > rules.common.length);
  assert.deepEqual(Object.keys(rules.types).filter((kind) => !ACCOUNT_POLICY_TYPES.includes(kind)), []);
  assert.doesNotMatch(text, /7600|8100|Pulsar|苍鹭|蓝鹊|RAM-\d|周报|注释|风险|weekly|Chinese|comment/i);
});

function fakeOv() {
  const calls = [];
  const custom = {};
  return {
    calls, custom,
    createAccount: async (key, body) => { calls.push(['create', key, body]); return { account_id: body.accountId, user_key: null, existed: true }; },
    call: async (path, { method = 'GET', key, body } = {}) => {
      calls.push([method, path, key]);
      const kind = path.split('/').pop();
      if (method === 'PUT') custom[kind] = body;
      if (method === 'DELETE') delete custom[kind];
      const defaults = native(kind);
      return { memory_type: kind, status: custom[kind] ? 'custom' : 'system_default', defaults, effective: custom[kind] ? { ...defaults, ...custom[kind] } : defaults };
    },
  };
}

test('the policy is published to the test workspace\'s own account and can be reset', async () => {
  const ov = fakeOv();
  const accountId = accountIdFor('ws-1');
  const applied = await applyAccountMemoryPolicy({ ov, rootKey: 'root', workspaceId: 'ws-1', policy });
  // The account is created under the plugin's own IDs before any template is written.
  assert.deepEqual(ov.calls[0], ['create', 'root', { accountId, adminUserId: adminUserIdFor('ws-1') }]);
  assert.ok(ov.calls.slice(1).every(([, path, key]) => key === 'root' && path.startsWith(`/api/v1/admin/accounts/${accountId}/memory-templates/`)));
  assert.deepEqual(Object.keys(ov.custom).sort(), [...ACCOUNT_POLICY_TYPES].sort());
  assert.deepEqual({ ...applied, digest: typeof applied.digest }, { scope: 'account', accountId, memoryTypes: ACCOUNT_POLICY_TYPES, digest: 'string' });
  assert.deepEqual(await resetAccountMemoryPolicy({ ov, rootKey: 'root', accountId }), { scope: 'native', accountId });
  assert.deepEqual(ov.custom, {});
});

test('setup fails when OpenViking does not keep an account template', async () => {
  const ov = fakeOv();
  const refusing = { ...ov, call: async (path, options = {}) => (options.method === 'PUT' ? { status: 'system_default', effective: native('profile') } : ov.call(path, options)) };
  await assert.rejects(applyAccountMemoryPolicy({ ov: refusing, rootKey: 'root', accountId: 'mc-existing', policy }), /did not keep the account memory template for profile/);
  // An existing account is used as is: no account is created without a workspace.
  assert.ok(ov.calls.every(([method]) => method !== 'create'));
  await assert.rejects(applyAccountMemoryPolicy({ ov, rootKey: 'root', policy }), /workspace or account ID/);
});

test('native and account runs start from the same pre-created account', async () => {
  const nativeRun = fakeOv();
  assert.deepEqual(await prepareTestAccount({ ov: nativeRun, rootKey: 'root', workspaceId: 'ws-2', mode: 'native', policy }), { scope: 'native', accountId: accountIdFor('ws-2') });
  assert.deepEqual(nativeRun.calls[0], ['create', 'root', { accountId: accountIdFor('ws-2'), adminUserId: adminUserIdFor('ws-2') }]);
  assert.ok(nativeRun.calls.slice(1).every(([method]) => method === 'GET'));
  assert.deepEqual(nativeRun.custom, {});
  const accountRun = fakeOv();
  assert.equal((await prepareTestAccount({ ov: accountRun, rootKey: 'root', workspaceId: 'ws-3', mode: 'account', policy })).scope, 'account');
  assert.deepEqual(accountRun.calls[0][0], 'create');
  assert.deepEqual(Object.keys(accountRun.custom).sort(), [...ACCOUNT_POLICY_TYPES].sort());
});

test('config runs start from OV\'s defaults; the plugin\'s rules show up as custom templates', async () => {
  const ov = fakeOv();
  const accountId = accountIdFor('ws-5');
  assert.deepEqual(await prepareTestAccount({ ov, rootKey: 'root', workspaceId: 'ws-5', mode: 'config', policy }), { scope: 'config', accountId });
  assert.deepEqual(ov.custom, {});
  await assert.rejects(prepareTestAccount({ ov, rootKey: 'root', workspaceId: 'ws-5', mode: 'instance', policy }), /Unknown memory policy/);
  assert.deepEqual(Object.values(await inspectAccountTemplates({ ov, rootKey: 'root', accountId })), ACCOUNT_POLICY_TYPES.map(() => ({ status: 'system_default', rules: false })));
  // What the plugin writes for the rules file.
  await writeAccountTemplates({ ov, key: 'root', accountId, rules: parseMemoryRules(loadMemoryRules()).rules });
  const templates = await inspectAccountTemplates({ ov, rootKey: 'root', accountId });
  assert.deepEqual(templates.entities, { status: 'custom', rules: true });
  assert.ok(Object.values(templates).every((t) => t.status === 'custom' && t.rules), JSON.stringify(templates));
  // The test-only account policy is a different heading: not mistaken for the plugin's rules.
  const other = fakeOv();
  await applyAccountMemoryPolicy({ ov: other, rootKey: 'root', accountId, policy });
  assert.equal((await inspectAccountTemplates({ ov: other, rootKey: 'root', accountId })).entities.rules, false);
  assert.equal((await inspectAccountTemplates({ ov: other, rootKey: 'root', accountId, heading: POLICY_HEADING })).entities.rules, true);
  assert.notEqual(POLICY_HEADING, WORKSPACE_RULES_HEADING);
});

test('a leftover instance-level policy stops the run before any model call', async () => {
  const ov = fakeOv();
  const leftover = { ...ov, call: async (path, options = {}) => {
    const result = await ov.call(path, options);
    return { ...result, defaults: { ...result.defaults, description: `${result.defaults.description}\n\n${POLICY_HEADING}\n- old rule` } };
  } };
  for (const mode of ['native', 'account']) {
    await assert.rejects(prepareTestAccount({ ov: leftover, rootKey: 'root', workspaceId: 'ws-4', mode, policy }), /remove memory\.custom_templates_dir/);
  }
  assert.deepEqual(ov.custom, {});
});
