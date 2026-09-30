import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeKey } from '../src/scopes.mjs';
import {
  startFakeOv, startFakeMultica, fixtureIssue, fixtureTask, hookBody, commentEvent,
  FIXTURE_WS, FIXTURE_ISSUE_ID, FIXTURE_ISSUE2_ID, FIXTURE_AGENT_A,
} from './helpers.mjs';
import { bootService, waitFor } from './harness.mjs';

// The agent-trigger tools, called exactly as multica calls them.

const toolBody = (hookKey, input, cb, extra = {}) => hookBody({
  hookKey, trigger: 'agent', actor: { type: 'agent', id: FIXTURE_AGENT_A }, callbackUrl: cb, input, extra,
});

async function withStack({ taskApi = false, tasks = {}, cfg } = {}, fn) {
  const ov = await startFakeOv();
  const multica = await startFakeMultica({
    issue: fixtureIssue(),
    issues: [fixtureIssue({ id: FIXTURE_ISSUE2_ID, identifier: 'MUL-8', title: '另一个任务' })],
    tasks, taskApi,
  });
  const svc = await bootService({ ov, cfg });
  const cb = multica.baseUrl + '/v1';
  try {
    // Seed MUL-7's task collaboration memory with one archived member comment.
    await svc.signedPost('/hooks/memory-archive', hookBody({ eventType: 'comment.created', callbackUrl: cb,
      input: commentEvent({ id: 'cm-seed', content: '死信队列的监控告警阈值定为 1 万条。' }) }));
    const rec = await waitFor(() => svc.registry.get(scopeKey('task', FIXTURE_WS, FIXTURE_ISSUE_ID)), { label: 'task scope' });
    await waitFor(() => [...ov.filesOf(rec.apiKey).keys()].some((u) => u.includes('/memories/')), { label: 'seed distilled' });
    await fn({ ov, multica, svc, cb });
  } finally {
    await svc.stop();
    await multica.stop();
    await ov.stop();
  }
}

test('stock multica: recall by issue key finds the task memory (keys resolve to the issue UUID)', async () => {
  await withStack({}, async ({ svc, cb }) => {
    const r = await svc.signedPost('/hooks/memory-recall', toolBody('memory-recall', { query: '死信队列 告警', issue_id: 'MUL-7' }, cb));
    assert.equal(r.status, 200, r.text);
    const result = r.json.result;
    assert.equal(result.run.bound, false);
    assert.ok(result.scopesSearched.some((s) => s.scope === scopeKey('task', FIXTURE_WS, FIXTURE_ISSUE_ID)), JSON.stringify(result.scopesSearched));
    assert.ok(result.entries.some((e) => e.scope.startsWith('task:') && /1 万条/.test(e.content ?? '')), 'hit carries its content, first line included');
  });
});

test('patched multica: recall is bound to the calling run, whatever issue the model names', async () => {
  const taskId = 'run-in-mul-8';
  await withStack({ taskApi: true, tasks: { [taskId]: fixtureTask({ taskId, issueId: FIXTURE_ISSUE2_ID }) } }, async ({ svc, cb }) => {
    // The agent is running on MUL-8 but asks for MUL-7's memory.
    const r = await svc.signedPost('/hooks/memory-recall',
      toolBody('memory-recall', { query: '死信队列 告警', issue_id: 'MUL-7' }, cb, { task_id: taskId, issue_id: FIXTURE_ISSUE2_ID }));
    assert.equal(r.status, 200, r.text);
    const result = r.json.result;
    assert.equal(result.run.bound, true);
    assert.equal(result.run.kind, 'issue');
    assert.ok(result.scopesSearched.every((s) => s.scope !== scopeKey('task', FIXTURE_WS, FIXTURE_ISSUE_ID)), 'MUL-7 is not searched');
    assert.ok(result.scopesSearched.some((s) => s.scope === scopeKey('task', FIXTURE_WS, FIXTURE_ISSUE2_ID)), 'its own run\'s issue is');
    assert.ok(result.notes.some((n) => /不属于当前运行/.test(n)));
    assert.equal(result.entries.length, 0);

    // Without naming anything, the run's own task memory is included.
    const own = await svc.signedPost('/hooks/memory-recall', toolBody('memory-recall', { query: 'anything' }, cb, { task_id: taskId, issue_id: FIXTURE_ISSUE2_ID }));
    assert.ok(own.json.result.scopesSearched.some((s) => s.scope === scopeKey('task', FIXTURE_WS, FIXTURE_ISSUE2_ID)));
  });
});

test('recall answers inside its budget when a space is slow, and says the result may be incomplete', async () => {
  await withStack({ cfg: { recallBudgetMs: 2_000 } }, async ({ ov, svc, cb }) => {
    const rec = svc.registry.get(scopeKey('task', FIXTURE_WS, FIXTURE_ISSUE_ID));
    ov.searchDelayMs.set(rec.apiKey, 4_000);
    const started = Date.now();
    const r = await svc.signedPost('/hooks/memory-recall', toolBody('memory-recall', { query: '死信队列 告警', issue_id: 'MUL-7' }, cb));
    assert.ok(Date.now() - started < 3_000, `answered in ${Date.now() - started}ms`);
    assert.equal(r.json.status, 'ok', r.text);
    const result = r.json.result;
    assert.equal(result.scopesSearched.find((s) => s.scope === scopeKey('task', FIXTURE_WS, FIXTURE_ISSUE_ID)).timedOut, true);
    assert.ok(result.notes.some((n) => /没有在时限内返回/.test(n)), JSON.stringify(result.notes));
  });
});

test('tool failures come back as a readable 200 payload, not a bare 500', async () => {
  await withStack({}, async ({ svc, cb }) => {
    const empty = await svc.signedPost('/hooks/memory-recall', toolBody('memory-recall', { query: '' }, cb));
    assert.equal(empty.status, 200);
    assert.equal(empty.json.status, 'error');
    assert.match(empty.json.error.message, /query is required/);

    const notAgent = await svc.signedPost('/hooks/memory-remember', hookBody({ hookKey: 'memory-remember', trigger: 'agent', actor: { type: 'member', id: 'm1' }, callbackUrl: cb, input: { content: 'x' } }));
    assert.equal(notAgent.status, 200);
    assert.match(notAgent.json.error.message, /only callable by an agent/);
  });
});

test('remembering the same thing twice is idempotent, not an error', async () => {
  await withStack({}, async ({ ov, svc, cb }) => {
    const input = { title: '发布窗口', content: '发布窗口只在周二和周四。', kind: 'preferences' };
    const first = await svc.signedPost('/hooks/memory-remember', toolBody('memory-remember', input, cb));
    const second = await svc.signedPost('/hooks/memory-remember', toolBody('memory-remember', input, cb));
    assert.equal(first.json.result.status, 'remembered', first.text);
    assert.equal(second.json.status, 'ok', second.text);
    assert.equal(second.json.result.status, 'already_remembered');
    assert.equal(second.json.result.uri, first.json.result.uri);
    assert.match(first.json.result.uri, /^viking:\/\/user\/[^/]+\/memories\/preferences\//);

    // The new memory's folder gets a semantic record, in the background, so a
    // reranked OV search can reach it.
    const rec = svc.registry.get(scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_A));
    const folder = first.json.result.uri.slice(0, first.json.result.uri.lastIndexOf('/'));
    assert.deepEqual(ov.spaces.get(rec.apiKey).reindexes, [{ uri: folder, mode: 'semantic_and_vectors', recursive: false, wait: false }]);
  });
});

test('memory-status separates archived from extracted, per workspace', async () => {
  await withStack({}, async ({ svc, cb }) => {
    const r = await svc.signedPost('/hooks/memory-status', toolBody('memory-status', {}, cb));
    assert.equal(r.status, 200, r.text);
    const s = r.json.result;
    assert.equal(s.openviking.healthy, true);
    assert.ok(s.archive_queue.done >= 1);
    assert.ok(s.recent_archives.some((e) => e.type === 'extraction' && e.extraction === 'done'));
    assert.ok(s.recent_archives.every((e) => !('archive_uri' in e)));
  });
});
