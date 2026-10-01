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

async function withStack({ taskApi = false, tasks = {}, cfg, ovOpts = {} } = {}, fn) {
  const ov = await startFakeOv({ requireReindex: true, ...ovOpts });
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

test('bound identifier-only recall uses its own issue goal and never another requested issue', async () => {
  const taskId = '11111111-2222-4333-8444-555555555555';
  await withStack({ taskApi: true, tasks: { [taskId]: fixtureTask({ taskId, issueId: FIXTURE_ISSUE2_ID }) } }, async ({ svc, cb }) => {
    const query = `${taskId} task context related memories`;
    const response = await svc.signedPost('/hooks/memory-recall', toolBody('memory-recall', { query, issue_id: 'MUL-7' }, cb, { task_id: taskId }));
    assert.equal(response.json.result.query_rewritten_from, query);
    assert.match(response.json.result.query, /另一个任务/);
    assert.ok(response.json.result.query.startsWith('另一个任务'));
    assert.ok(response.json.result.scopesSearched.every(s => s.scope !== scopeKey('task', FIXTURE_WS, FIXTURE_ISSUE_ID)));
    const explicit = await svc.signedPost('/hooks/memory-recall', toolBody('memory-recall', { query: '指定业务问题' }, cb, { task_id: taskId }));
    assert.equal(explicit.json.result.query, '指定业务问题');
    assert.equal(explicit.json.result.query_rewritten_from, undefined);
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

    assert.equal(second.json.result.index_job, first.json.result.index_job);
    await waitFor(async () => {
      const recalled = await svc.signedPost('/hooks/memory-recall', toolBody('memory-recall', { query: '发布窗口' }, cb));
      return recalled.json.result.entries.some((e) => e.uri === first.json.result.uri && e.content.includes(input.content));
    });
    const rec = svc.registry.get(scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_A));
    assert.equal(ov.spaces.get(rec.apiKey).reindexes.length, 1, 'in-flight duplicates share one index task');
  });
});

for (const failure of ['request', 'background task']) {
  test(`remember automatically recovers an indexing ${failure} failure`, async () => {
    await withStack({ ovOpts: { reindexBehavior: failure === 'background task' ? 'fail-first' : 'succeed' } }, async ({ svc, cb }) => {
      const reindex = svc.ovClient.reindex.bind(svc.ovClient);
      let calls = 0;
      svc.ovClient.reindex = async (...args) => {
        if (++calls === 1 && failure === 'request') throw new Error('temporary index outage');
        return reindex(...args);
      };
      const input = { title: '灰度验收', content: '灰度验收必须核对退款到账时间。', kind: 'experiences' };
      const first = await svc.signedPost('/hooks/memory-remember', toolBody('memory-remember', input, cb));
      assert.equal(first.status, 200);
      assert.equal(first.json.result.status, 'remembered', first.text);
      const before = await svc.signedPost('/hooks/memory-recall', toolBody('memory-recall', { query: '退款到账时间' }, cb));
      assert.equal(before.json.result.entries.some((e) => e.content?.includes(input.content)), false, 'unindexed file cannot be recalled');
      const retry = await svc.signedPost('/hooks/memory-remember', toolBody('memory-remember', input, cb));
      assert.equal(retry.json.result.status, 'already_remembered', retry.text);
      await waitFor(async () => {
        const after = await svc.signedPost('/hooks/memory-recall', toolBody('memory-recall', { query: '退款到账时间' }, cb));
        return after.json.result.entries.some((e) => e.uri === retry.json.result.uri && e.content.includes(input.content));
      });
      assert.ok(calls >= 2, 'failure retried without another agent call');
      if (failure === 'background task') assert.equal(svc.queue.jobs.get(first.json.result.index_job).payload.generation, 1);
    });
  });
}

test('remember reports a failed durable index enqueue and can repair it with the same content', async () => {
  await withStack({}, async ({ svc, cb }) => {
    const input = { title: '发布清单', content: '发布前核对回滚负责人。' };
    const journal = svc.queue.path;
    svc.queue.path = svc.stateDir;
    let first;
    try {
      first = await svc.signedPost('/hooks/memory-remember', toolBody('memory-remember', input, cb));
      assert.equal(first.json.error?.code, 'index_unavailable', first.text);
      assert.match(first.json.error.message, /已写入.*未能持久化/);
    } finally { svc.queue.path = journal; }
    const duplicate = await svc.signedPost('/hooks/memory-remember', toolBody('memory-remember', input, cb));
    assert.equal(duplicate.json.result?.status, 'already_remembered', duplicate.text);
    await waitFor(async () => {
      const recall = await svc.signedPost('/hooks/memory-recall', toolBody('memory-recall', { query: '回滚负责人' }, cb));
      return recall.json.result.entries.some((e) => e.uri === duplicate.json.result.uri && e.content.includes(input.content));
    });
  });
});

test('two memories in one folder survive a reindex conflict without blocking another archive', async () => {
  await withStack({ ovOpts: { pollsToFinish: 3 }, cfg: { queueMaxAttempts: 8 } }, async ({ ov, svc, cb }) => {
    const inputs = [
      { title: '回滚流程', content: '回滚前必须确认数据库迁移可逆。', kind: 'experiences' },
      { title: '上线流程', content: '上线前必须通知值班负责人。', kind: 'experiences' },
    ];
    const remembered = [];
    for (const input of inputs) remembered.push((await svc.signedPost('/hooks/memory-remember', toolBody('memory-remember', input, cb))).json.result);
    const comment = await svc.signedPost('/hooks/memory-archive', hookBody({ eventType: 'comment.created', callbackUrl: cb,
      input: commentEvent({ id: 'cm-during-index', content: '故障演练安排在周三。' }) }));
    assert.equal(comment.json.result.status, 'queued');
    const rec = svc.registry.get(scopeKey('task', FIXTURE_WS, FIXTURE_ISSUE_ID));
    await waitFor(() => ov.archivedOf(rec.apiKey, 'mc-comment-cm-during-index').length);
    const first = svc.queue.jobs.get(remembered[0].index_job);
    assert.equal(ov.taskStates.get(first.cp.indexTaskId).status, 'pending', 'slow indexing does not hold up archive submission');
    await waitFor(async () => {
      const recalled = await svc.signedPost('/hooks/memory-recall', toolBody('memory-recall', { query: '回滚 上线 流程' }, cb));
      return remembered.every((r, i) => recalled.json.result.entries.some((e) => e.uri === r.uri && e.content.includes(inputs[i].content)));
    });
    await waitFor(() => remembered.every((r) => !svc.extractions.isPinned(r.index_job)));
    assert.ok(svc.queue.jobs.get(remembered[1].index_job).attempts > 0, 'folder conflict was retried');
  });
});

test('remember can repair an index after the automatic redrive budget is exhausted', async () => {
  await withStack({ cfg: { extractMaxRedrives: 0 } }, async ({ svc, cb }) => {
    const reindex = svc.ovClient.reindex.bind(svc.ovClient);
    const getTask = svc.ovClient.getTask.bind(svc.ovClient);
    let failedTask;
    svc.ovClient.reindex = async (...args) => { const result = await reindex(...args); failedTask = result.task_id; return result; };
    svc.ovClient.getTask = async (key, id) => id === failedTask ? { status: 'failed', error: 'index provider unavailable' } : getTask(key, id);
    const input = { title: '验收要求', content: '验收必须包含支付失败场景。' };
    const first = await svc.signedPost('/hooks/memory-remember', toolBody('memory-remember', input, cb));
    const id = first.json.result.index_job;
    await waitFor(() => svc.statusLog.recent({ limit: 50 }).some((e) => e.type === 'extraction' && e.record === 'index-memory' && e.extraction === 'failed'));
    // The fake keeps its first task pending until polled; finish it so the next
    // request models a settled OV task rather than a resource-lock conflict.
    await getTask(svc.registry.get(scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_A)).apiKey, failedTask);
    svc.ovClient.getTask = getTask;
    svc.ovClient.reindex = reindex;
    const repair = await svc.signedPost('/hooks/memory-remember', toolBody('memory-remember', input, cb));
    assert.equal(repair.json.result.status, 'already_remembered');
    assert.equal(repair.json.result.index_job, id);
    assert.equal(svc.queue.jobs.get(id).payload.generation, 1);
    await waitFor(() => !svc.extractions.isPinned(id) && svc.queue.jobs.get(id).status === 'done');
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
