import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstReceiver, checkDelegationHistory } from '../e2e/real-agent/delegation-check.mjs';

const A = 'agent-a';
const B = 'agent-b';

// Tasks per agent; `ticks` advances a scripted timeline on every poll of A.
function scripted(timeline) {
  let tick = 0;
  return async (agentId) => {
    if (agentId === A) tick++;
    const at = timeline[Math.min(tick, timeline.length - 1)];
    return at[agentId] ?? [];
  };
}

test('the receiver is the earliest task on the issue, not a later rerun from a self-mention', async () => {
  const tasksOf = scripted([{
    [A]: [{ id: 'a1', issue_id: 'i', status: 'completed', created_at: '2026-10-08T10:00:00Z' }],
    [B]: [
      { id: 'b2', issue_id: 'i', status: 'queued', created_at: '2026-10-08T10:02:00Z' },
      { id: 'b-other', issue_id: 'other', status: 'completed', created_at: '2026-10-08T09:00:00Z' },
      { id: 'b1', issue_id: 'i', status: 'running', created_at: '2026-10-08T10:01:00Z' },
    ],
  }]);
  const { sender, receiver } = await firstReceiver({ tasksOf, issueId: 'i', fromAgentId: A, toAgentId: B, poll: 1 });
  assert.equal(sender.id, 'a1');
  assert.equal(receiver.id, 'b1');
});

test('a sender that finishes without the mention ends the wait after the grace period', async () => {
  const tasksOf = scripted([{ [A]: [{ id: 'a1', issue_id: 'i', status: 'completed', created_at: 't' }] }]);
  const started = Date.now();
  const { sender, receiver } = await firstReceiver({ tasksOf, issueId: 'i', fromAgentId: A, toAgentId: B, timeout: 60000, grace: 30, poll: 5 });
  assert.equal(sender.id, 'a1');
  assert.equal(receiver, null);
  assert.ok(Date.now() - started < 5000, 'no wait for the full deadline');
});

test('a mention that lands within the grace period is still picked up', async () => {
  const a = [{ id: 'a1', issue_id: 'i', status: 'completed', created_at: 't0' }];
  const tasksOf = scripted([{ [A]: a }, { [A]: a }, { [A]: a, [B]: [{ id: 'b1', issue_id: 'i', status: 'queued', created_at: 't1' }] }]);
  const { receiver } = await firstReceiver({ tasksOf, issueId: 'i', fromAgentId: A, toAgentId: B, grace: 1000, poll: 1 });
  assert.equal(receiver.id, 'b1');
});

test('a failed sender and a sender still running at the deadline stop the suite', async () => {
  const failed = scripted([{ [A]: [{ id: 'a1', issue_id: 'i', status: 'failed', error: 'provider 401', created_at: 't' }] }]);
  await assert.rejects(firstReceiver({ tasksOf: failed, issueId: 'i', fromAgentId: A, toAgentId: B, poll: 1 }), /sender failed: provider 401/);
  const running = scripted([{ [A]: [{ id: 'a1', issue_id: 'i', status: 'running', created_at: 't' }] }]);
  await assert.rejects(firstReceiver({ tasksOf: running, issueId: 'i', fromAgentId: A, toAgentId: B, timeout: 20, poll: 1 }), /neither handed off nor finished/);
});

function historyStack({ handsOff }) {
  const tasks = { [A]: [], [B]: [] };
  const comments = [];
  let issue;
  const ok = (json) => ({ status: 200, json });
  const mc = {
    async must(_label, promise) { return (await promise).json; },
    async call(path) {
      let m = path.match(/^\/api\/agents\/([^/]+)\/tasks$/);
      if (m) return ok(tasks[m[1]]);
      m = path.match(/^\/api\/tasks\/([^/]+)\/messages$/);
      if (m) return ok(m[1] === 'b1' ? [{ type: 'tool_result', tool: 'memory-recall', output: JSON.stringify({ status: 'ok', result: { run: { bound: true }, entries: [{ scope: 'delegation:w:a:b', uri: 'viking://x/retry.md' }] } }) }] : [{ type: 'text', content: '未找到，不做猜测。' }]);
      if (/\/comments$/.test(path)) return ok(comments);
      throw new Error(`unexpected ${path}`);
    },
    async createIssue(_t, _w, { title, description }) { issue = { id: 'i', title, description }; return issue; },
    async assign() {
      tasks[A].push({ id: 'a1', agent_id: A, issue_id: 'i', status: 'completed', created_at: 't0' });
      comments.push({ author_id: A, source_task_id: 'a1', content: handsOff ? '[@复核智能体](mention://agent/agent-b) 请查询' : '没有找到重试上限，不做猜测。' });
      if (handsOff) {
        tasks[B].push({ id: 'b1', agent_id: B, issue_id: 'i', status: 'completed', created_at: 't1' });
        comments.push({ author_id: B, source_task_id: 'b1', content: '重试上限为 7 次。来源：viking://x/retry.md' });
      }
    },
  };
  return { mc, issue: () => issue };
}

test('a history handoff A answers itself is a recorded failure with the sender\'s transcript, not an abort', async () => {
  const previous = process.env.MULTICA_RUN_REAL_AGENT_SMOKE;
  process.env.MULTICA_RUN_REAL_AGENT_SMOKE = '1';
  try {
    const self = historyStack({ handsOff: false });
    const missed = await checkDelegationHistory({ mc: self.mc, user: { token: 't' }, ws: 'w', fromAgentId: A, toAgentId: B, channelScope: 'delegation:w:a:b', grace: 5, poll: 1 });
    assert.equal(missed.ok, false);
    assert.match(missed.detail, /never reached B/);
    assert.deepEqual(missed.records.map((r) => r.entry), ['delegation-history-sender']);
    assert.match(missed.records[0].response, /没有找到重试上限/);
    assert.match(self.issue().description, /你只负责转交，不要在这次运行直接回答/);

    const handed = await checkDelegationHistory({ mc: historyStack({ handsOff: true }).mc, user: { token: 't' }, ws: 'w', fromAgentId: A, toAgentId: B, channelScope: 'delegation:w:a:b', grace: 5, poll: 1 });
    assert.equal(handed.ok, true);
    assert.deepEqual(handed.records.map((r) => r.entry), ['delegation-history-sender', 'delegation-history-receiver']);
  } finally {
    if (previous === undefined) delete process.env.MULTICA_RUN_REAL_AGENT_SMOKE;
    else process.env.MULTICA_RUN_REAL_AGENT_SMOKE = previous;
  }
});
