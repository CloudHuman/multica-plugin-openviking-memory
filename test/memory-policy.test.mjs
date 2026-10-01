import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_POLICY_TYPES, POLICY_HEADING, accountTemplate, applyAccountMemoryPolicy, loadMemoryPolicy, resetAccountMemoryPolicy } from '../e2e/real-agent/memory-policy.mjs';
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
  // Common rules everywhere; type rules also on the content field when the type has one.
  assert.deepEqual(accountTemplate(native('preferences'), policy).fields.map((f) => f.name), ['content']);
  assert.deepEqual(Object.keys(accountTemplate(native('events'), policy)), ['description']);
  const profile = accountTemplate(native('profile'), policy);
  assert.deepEqual(Object.keys(profile), ['description']);
  assert.ok(policy.common.every((rule) => profile.description.includes(rule)));
});

test('the policy is plain text for account-editable types and carries no test answers', () => {
  const text = JSON.stringify(policy);
  // OpenViking renders descriptions as restricted Jinja; plain text stays verbatim.
  assert.doesNotMatch(text, /\{\{|\{%|\{#/);
  assert.deepEqual([...Object.keys(policy.types), ...Object.keys(policy.fields)].filter((kind) => !ACCOUNT_POLICY_TYPES.includes(kind)), []);
  // The suites' own values (budget 7600→8100, RAM-n keys, weekly-report and comment-language preferences).
  assert.doesNotMatch(text, /7600|8100|RAM-\d|周报|注释|weekly|Chinese/i);
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
