import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OvClient } from '../src/ov-client.mjs';
import { ScopeRegistry, accountIdFor, scopeKey } from '../src/scopes.mjs';
import { WORKSPACE_RULES_HEADING, WorkspaceMemoryRules, accountTemplate, parseMemoryRules } from '../src/memory-rules.mjs';
import {
  startFakeOv, startFakeMultica, fixtureIssue, fixtureTranscript, fixtureTask, hookBody, taskEvent, tempStateDir,
  FIXTURE_WS, FIXTURE_ISSUE_ID, FIXTURE_USER,
} from './helpers.mjs';
import { bootService, waitFor } from './harness.mjs';

const RULES = [
  '# Workspace rules, kept short',
  '- Keep an amount with the period it was stated with.',
  'preferences: Keep each lasting preference as its own memory.',
  'ENTITIES：Name a card after its subject, never after an issue.',
  '',
  '1. A search that found nothing is not a business fact.',
].join('\n');

test('rules are one per line, scoped by an optional memory-type prefix', () => {
  const { rules, errors, count } = parseMemoryRules(RULES);
  assert.deepEqual(errors, []);
  assert.equal(count, 4);
  assert.deepEqual(rules.common, ['Keep an amount with the period it was stated with.', 'A search that found nothing is not a business fact.']);
  assert.deepEqual(rules.types, { preferences: ['Keep each lasting preference as its own memory.'], entities: ['Name a card after its subject, never after an issue.'] });
  assert.deepEqual(parseMemoryRules('').count, 0);
  // OpenViking renders descriptions as restricted Jinja: rules stay plain text.
  assert.match(parseMemoryRules('Use {{ language }} for names').errors[0], /line 1: template syntax/);
  assert.match(parseMemoryRules('x'.repeat(1001)).errors[0], /longer than 1000/);
});

test('rules extend the native descriptions; a type without rules keeps its defaults', () => {
  const native = (kind, fields) => ({ memory_type: kind, description: `native ${kind}`, fields: fields.map((name) => ({ name, description: `native ${name}` })) });
  const { rules } = parseMemoryRules('preferences: Keep each lasting preference as its own memory.');
  assert.equal(accountTemplate(native('profile', ['content']), rules), null);
  const preferences = accountTemplate(native('preferences', ['user', 'topic', 'content']), rules);
  assert.equal(preferences.description, `native preferences\n\n${WORKSPACE_RULES_HEADING}\n- Keep each lasting preference as its own memory.`);
  assert.deepEqual(preferences.fields, [{ name: 'content', description: 'native content\nKeep each lasting preference as its own memory.' }]);
  // General rules are written once, under entities; other types point to them.
  const general = parseMemoryRules('Keep an amount with its period.').rules;
  assert.match(accountTemplate(native('entities', ['content']), general).description, /- Keep an amount with its period\.$/);
  assert.match(accountTemplate(native('events', ['summary']), general).description, /- Also apply the general rules listed under this heading in the entities memory type\.$/);
});

async function withRules(fn) {
  const ov = await startFakeOv();
  const client = new OvClient({ baseUrl: ov.baseUrl, timeoutMs: 3000 });
  const registry = new ScopeRegistry({ ov: client, rootKey: 'root', stateDir: tempStateDir() });
  const logs = [];
  const memoryRules = new WorkspaceMemoryRules({ ov: client, registry, log: (line) => logs.push(line) });
  const templateCalls = () => ov.calls.filter((c) => c.path.includes('/memory-templates/') && c.method !== 'GET').length;
  try {
    await fn({ ov, registry, memoryRules, templateCalls, accountId: accountIdFor(FIXTURE_WS), logs });
  } finally {
    await ov.stop();
  }
}

test('a workspace\'s rules are written to its own account, kept in sync, and cleared back to the defaults', async () => {
  await withRules(async ({ ov, memoryRules, templateCalls, accountId }) => {
    // No config in the delivery, or no rules ever set: nothing is touched.
    await memoryRules.ensure(FIXTURE_WS, undefined);
    await memoryRules.ensure(FIXTURE_WS, '');
    assert.equal(templateCalls(), 0);
    assert.deepEqual(memoryRules.status(FIXTURE_WS), { status: 'default' });

    await memoryRules.ensure(FIXTURE_WS, RULES);
    const templates = ov.templatesOf(accountId);
    assert.deepEqual(Object.keys(templates).sort(), ['entities', 'events', 'preferences', 'profile']);
    assert.match(templates.entities.description, /native entities\n\n## Workspace memory rules\n- Keep an amount with the period it was stated with\./);
    assert.match(templates.preferences.description, /Keep each lasting preference as its own memory\./);
    const applied = memoryRules.status(FIXTURE_WS);
    assert.equal(applied.status, 'applied');
    assert.equal(applied.rules, 4);
    assert.deepEqual(applied.memory_types, ['profile', 'events', 'preferences', 'entities']);
    assert.equal(JSON.stringify(applied).includes('lasting preference'), false, 'status never echoes rule text');

    // The same rules again: settled, no writes.
    const writes = templateCalls();
    await memoryRules.ensure(FIXTURE_WS, RULES);
    assert.equal(templateCalls(), writes);

    // Narrower rules: types this workspace no longer has rules for go back to the defaults.
    await memoryRules.ensure(FIXTURE_WS, 'preferences: Keep each lasting preference as its own memory.');
    assert.deepEqual(Object.keys(ov.templatesOf(accountId)), ['preferences']);
    assert.deepEqual(memoryRules.status(FIXTURE_WS).memory_types, ['preferences']);

    // Cleared: back to OpenViking's defaults.
    await memoryRules.ensure(FIXTURE_WS, '');
    assert.deepEqual(ov.templatesOf(accountId), {});
    assert.equal(memoryRules.status(FIXTURE_WS).status, 'default');
  });
});

test('templates the plugin did not write are left alone, and invalid rules keep the published ones', async () => {
  await withRules(async ({ ov, registry, memoryRules, accountId }) => {
    const { adminKey } = await registry.ensureAccount(FIXTURE_WS);
    // Someone else customised profile through OpenViking's own API.
    await new OvClient({ baseUrl: ov.baseUrl }).call(`/api/v1/admin/accounts/${accountId}/memory-templates/profile`, { method: 'PUT', key: adminKey, body: { description: 'operator profile rules' } });
    await memoryRules.ensure(FIXTURE_WS, 'entities: Name a card after its subject.');
    await memoryRules.ensure(FIXTURE_WS, 'entities: Name a card after {{ issue }}.');
    assert.equal(memoryRules.status(FIXTURE_WS).status, 'invalid');
    assert.match(memoryRules.status(FIXTURE_WS).error, /template syntax/);
    assert.match(ov.templatesOf(accountId).entities.description, /Name a card after its subject\./, 'the last valid rules stay published');
    await memoryRules.ensure(FIXTURE_WS, '');
    assert.deepEqual(Object.keys(ov.templatesOf(accountId)), ['profile']);
    assert.equal(ov.templatesOf(accountId).profile.description, 'operator profile rules');
  });
});

test('an OpenViking failure is recorded without failing the caller, and not retried at once', async () => {
  const registry = new ScopeRegistry({
    ov: { createAccount: async () => ({ user_key: 'admin-key' }) }, rootKey: 'root', stateDir: tempStateDir(),
  });
  let calls = 0;
  const ov = { call: async () => { calls++; throw Object.assign(new Error('HTTP 404 memory-templates: Not Found'), { status: 404 }); } };
  const memoryRules = new WorkspaceMemoryRules({ ov, registry });
  assert.equal(await memoryRules.ensure(FIXTURE_WS, 'entities: Name a card after its subject.'), null);
  assert.equal(memoryRules.status(FIXTURE_WS).status, 'error');
  assert.match(memoryRules.status(FIXTURE_WS).error, /404/);
  const attempted = calls;
  await memoryRules.ensure(FIXTURE_WS, 'entities: Name a card after its subject.');
  assert.equal(calls, attempted, 'the same rules are retried only after a pause');
});

test('the installation\'s rules reach its OpenViking account before the run is committed', async () => {
  const taskId = 'run-rules-1';
  const ov = await startFakeOv();
  const multica = await startFakeMultica({ issue: fixtureIssue(), tasks: { [taskId]: fixtureTask({ taskId, input: [{ source: 'comment', author_type: 'member', author_id: FIXTURE_USER, content: '请比较 Kafka 与 RocketMQ' }] }) }, transcript: fixtureTranscript({ taskId }), taskApi: true });
  const svc = await bootService({ ov });
  const cb = multica.baseUrl + '/v1';
  const accountId = accountIdFor(FIXTURE_WS);
  try {
    const body = hookBody({ eventType: 'task.completed', input: taskEvent({ taskId }), callbackUrl: cb });
    body.config = { memory_rules: 'preferences: Keep each lasting preference as its own memory.' };
    const r = await svc.signedPost('/hooks/memory-archive', body);
    assert.equal(r.json.result.status, 'queued', r.text);
    const taskScope = scopeKey('task', FIXTURE_WS, FIXTURE_ISSUE_ID);
    const rec = await waitFor(() => svc.registry.get(taskScope), { label: 'task scope' });
    await waitFor(() => ov.archivedOf(rec.apiKey, `mc-task-${taskId}`).length, { label: 'run archive' });
    assert.match(ov.templatesOf(accountId).preferences.description, /Keep each lasting preference as its own memory\./);
    const put = ov.calls.findIndex((c) => c.method === 'PUT' && c.path.endsWith('/memory-templates/preferences'));
    const commit = ov.calls.findIndex((c) => c.method === 'POST' && c.path === `/api/v1/sessions/mc-task-${taskId}/commit`);
    assert.ok(put >= 0 && commit > put, 'templates are written before the run is committed');

    const status = await svc.signedPost('/hooks/memory-status', hookBody({ hookKey: 'memory-status', trigger: 'agent', callbackUrl: cb, input: {} }));
    assert.equal(status.json.result.memory_rules.status, 'applied', status.text);

    // The admin clears the field: the next delivery restores OpenViking's defaults.
    const cleared = hookBody({ eventType: 'task.completed', input: taskEvent({ taskId: 'run-rules-2' }), callbackUrl: cb });
    await svc.signedPost('/hooks/memory-archive', cleared);
    await waitFor(() => !Object.keys(ov.templatesOf(accountId)).length, { label: 'templates reset' });
    assert.equal(svc.app.memoryRules.status(FIXTURE_WS).status, 'default');
  } finally {
    await svc.stop();
    await multica.stop();
    await ov.stop();
  }
});
