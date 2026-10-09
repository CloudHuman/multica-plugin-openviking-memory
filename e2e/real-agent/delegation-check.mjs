import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sleep } from '../real-stack/multica.mjs';
import { toolResultData } from './tool-output.mjs';
import { citesUri } from './answer-checks.mjs';

const DONE = ['completed', 'failed', 'cancelled'];
const firstOn = (tasks, issueId) => tasks.filter(t => t.issue_id === issueId).sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)))[0];

// The receiver's delegated run is its first task on the issue: a reply that
// mentions it again starts another. A sender that finishes without the
// mention dispatches nothing, so after `grace` the wait ends with no receiver
// instead of running out the deadline.
export async function firstReceiver({ tasksOf, issueId, fromAgentId, toAgentId, timeout = 600000, grace = 120000, poll = 1500 }) {
  const deadline = Date.now() + timeout;
  let senderDoneAt;
  while (Date.now() < deadline) {
    const sender = firstOn(await tasksOf(fromAgentId), issueId);
    const receiver = firstOn(await tasksOf(toAgentId), issueId);
    if (receiver) return { sender, receiver };
    if (sender?.status === 'failed') throw new Error(`Delegation sender failed: ${sender.error}`);
    if (DONE.includes(sender?.status)) {
      senderDoneAt ??= Date.now();
      if (Date.now() - senderDoneAt >= grace) return { sender, receiver: null };
    }
    await sleep(poll);
  }
  throw new Error('Delegation sender neither handed off nor finished in time');
}

// Multica dispatches a comment that mentions its own author (meant for
// notifying another issue), and a receiver that copies the handoff's mention
// into its reply is dispatched again after every run: in the 10-08 regression
// B ran 31 more times in 13 minutes. The guard cancels a receiver's later runs
// on the handoff issues it watches and lists them.
export function selfMentionGuard({ tasksOf, cancel, interval = 5000 }) {
  const watched = new Map();
  const cancelled = new Set();
  let sweeping = null;
  const sweep = () => sweeping ??= (async () => {
    for (const [issueId, { agentId, keep }] of watched) {
      for (const t of await tasksOf(agentId)) {
        if (t.issue_id !== issueId || t.id === keep || DONE.includes(t.status) || cancelled.has(t.id)) continue;
        await cancel(t.id);
        cancelled.add(t.id);
      }
    }
  })().catch(() => { /* the next sweep retries */ }).finally(() => { sweeping = null; });
  const timer = setInterval(sweep, interval);
  timer.unref?.();
  return {
    watch(issueId, agentId, keep) { watched.set(issueId, { agentId, keep }); },
    async stop() {
      clearInterval(timer);
      await sweeping;
      await sweep();
      const reruns = [];
      try {
        for (const [issueId, { agentId, keep }] of watched) {
          for (const t of await tasksOf(agentId)) if (t.issue_id === issueId && t.id !== keep) reruns.push({ issueId, agentId, taskId: t.id, status: t.status, cancelled: cancelled.has(t.id) });
        }
      } catch { /* report what was listed */ }
      return reruns;
    },
  };
}

// Recorded on the report: the reruns are the platform's and the model's, not the plugin's.
export function recordSelfMentionReruns(report, reruns) {
  if (!reruns.length) return;
  report.selfMentionReruns = [...(report.selfMentionReruns ?? []), ...reruns];
  report.limitations ??= [];
  report.limitations.push({ entry: 'self-mention-reruns', count: reruns.length, cancelled: reruns.filter(r => r.cancelled).length, reason: 'The receiver mentioned itself in its reply and Multica dispatched it again on the same issue; the harness cancelled the reruns' });
}

export const handoffComment = (toAgentId) => `[@复核智能体](mention://agent/${toAgentId}) 雨燕项目之前确定的重试上限是多少？请调用 memory-recall 查询 A 到 B 委派通道，回答并引用来源 URI。`;

export async function checkDelegationHistory({ mc, user, ws, fromAgentId, toAgentId, channelScope, state, guard, timeout = 600000, grace, poll = 1500 }) {
  if (process.env.MULTICA_RUN_REAL_AGENT_SMOKE !== '1') throw new Error('Explicit real-agent authorization is required');
  const call = path => mc.must(path, mc.call(path, { token: user.token, ws }));
  const issue = await mc.createIssue(user.token, ws, {
    title: `新任务查询雨燕历史交接约定 ${randomUUID().slice(0, 8)}`,
    // The comment is given verbatim: asked to compose it, A has answered the
    // question itself or dropped the mention, and nothing reached B. It is the
    // last paragraph, so nothing meant for A can be copied along with it: A
    // once posted "不要猜测数字……提交简短最终回复" too, and B obeyed that instead.
    description: `这是一次新的、明确授权的历史交接测试。你只负责转交，不要在这次运行回答或查找答案，查不到也照样转交。本次没有提供上限数字，不要猜测数字、主动记忆或修改代码。交接后提交简短最终回复；后续完成通知只需确认，不要再次委派。请用 multica issue comment add 在当前 issue 原样发布下面这条评论，只发布一次；它是本描述的最后一段，开头的 mention 负责派发复核智能体，必须原样保留，不要添加其他文字：\n\n${handoffComment(toAgentId)}`,
  });
  await mc.assign(user.token, ws, issue.id, fromAgentId);
  const deadline = Date.now() + timeout;
  const tasksOf = agentId => call(`/api/agents/${agentId}/tasks`);
  let { sender, receiver } = await firstReceiver({ tasksOf, issueId: issue.id, fromAgentId, toAgentId, timeout, grace, poll });
  if (receiver) guard?.watch(issue.id, toAgentId, receiver.id);
  while (receiver && !DONE.includes(receiver.status)) {
    if (Date.now() >= deadline) throw new Error('History delegation receiver did not finish');
    await sleep(poll);
    receiver = firstOn(await tasksOf(toAgentId), issue.id);
  }
  sender = firstOn(await tasksOf(fromAgentId), issue.id);
  const records = [];
  for (const [role, task] of [['sender', sender], ['receiver', receiver]]) {
    if (!task) continue;
    const messages = await call(`/api/tasks/${task.id}/messages`);
    const comments = (await call(`/api/issues/${issue.id}/comments`)).filter(c => c.author_id === task.agent_id && c.source_task_id === task.id);
    const recalls = messages.filter(m => m.type === 'tool_result' && /memory.*recall/.test(m.tool ?? '')).map(m => toolResultData(m)?.result).filter(Boolean);
    const record = { entry: `delegation-history-${role}`, taskId: task.id, agentId: task.agent_id, issueId: issue.id, status: task.status, error: task.error ?? null, startedAt: task.started_at, completedAt: task.completed_at, response: [task.result?.output ?? '', ...comments.map(c => c.content)].join('\n'), tools: messages.filter(m => m.type === 'tool_use').map(m => m.tool), recalls };
    records.push(record);
    if (state) writeFileSync(join(state, `${record.entry}-${task.id}-transcript.json`), JSON.stringify(messages), { mode: 0o600 });
  }
  if (!receiver) return { ok: false, records, detail: 'The second handoff never reached B: A finished without mentioning B (see delegation-history-sender)' };
  const result = records.find(r => r.entry === 'delegation-history-receiver');
  const stated = /7\s*次|七次/.test(result.response);
  const cited = result.recalls.some(r => r.run?.bound === true && r.entries?.some(e => e.scope === channelScope && citesUri(result.response, e.uri)));
  const ok = result.status === 'completed' && stated && cited;
  const missed = result.status !== 'completed' ? `ended ${result.status}` : !result.recalls.length ? 'did not call memory-recall' : !cited ? 'cited no URI from the A to B channel' : 'did not state the retry limit';
  return { ok, records, detail: ok ? 'A second actual handoff omitted the number; B recovered the previous retry limit from its delegation channel and cited its URI' : `The second handoff reached B, which ${missed}` };
}

// REAL_AGENT_MATRIX_PHASE=history: only the second handoff, again, on a
// finished matrix's workspace and agents (its A to B channel is still there).
export async function recheckDelegationHistory({ mc, user, ws, report, agentTemplate, state, step, save }) {
  const id = role => report.agents?.find(a => a.role === role)?.id;
  const [fromAgentId, toAgentId] = [id('A'), id('B')];
  if (!fromAgentId || !toAgentId) throw new Error('The matrix has no A and B agents to hand off between');
  if (!report.tasks?.some(t => t.entry === 'delegation-receiver')) throw new Error('The first handoff never reached B: there is no delegation channel to recall');
  await mc.must('bind resumed B', mc.call(`/api/agents/${toAgentId}`, { method: 'PUT', token: user.token, ws, body: { runtime_id: agentTemplate.runtime_id } }));
  const call = (path, body) => mc.must(path, mc.call(path, { token: user.token, ws, method: body === undefined ? 'GET' : 'POST', body }));
  const guard = selfMentionGuard({ tasksOf: agentId => call(`/api/agents/${agentId}/tasks`), cancel: taskId => call(`/api/tasks/${taskId}/cancel`, {}) });
  let history;
  try {
    history = await checkDelegationHistory({ mc, user, ws, fromAgentId, toAgentId, channelScope: `delegation:${ws}:${fromAgentId}:${toAgentId}`, state, guard });
    report.tasks.push(...history.records);
  } finally {
    recordSelfMentionReruns(report, await guard.stop());
    save();
  }
  step('delegation-cross-task-recall', history.ok, history.detail);
  return history;
}
