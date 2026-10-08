import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sleep } from '../real-stack/multica.mjs';
import { toolResultData } from './tool-output.mjs';

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

export const handoffComment = (toAgentId) => `[@复核智能体](mention://agent/${toAgentId}) 雨燕项目之前确定的重试上限是多少？请调用 memory-recall 查询 A 到 B 委派通道，回答并引用来源 URI。`;

export async function checkDelegationHistory({ mc, user, ws, fromAgentId, toAgentId, channelScope, state, timeout = 600000, grace, poll = 1500 }) {
  if (process.env.MULTICA_RUN_REAL_AGENT_SMOKE !== '1') throw new Error('Explicit real-agent authorization is required');
  const call = path => mc.must(path, mc.call(path, { token: user.token, ws }));
  const issue = await mc.createIssue(user.token, ws, {
    title: `新任务查询雨燕历史交接约定 ${randomUUID().slice(0, 8)}`,
    // The comment is given verbatim: asked to compose it, A has answered the
    // question itself or dropped the mention, and nothing reached B.
    description: `这是一次新的、明确授权的历史交接测试。你只负责转交，不要在这次运行回答或查找答案，查不到也照样转交。请用 multica issue comment add 在当前 issue 原样发布下面这条评论，只发布一次；开头的 mention 负责派发复核智能体，必须原样保留：\n\n${handoffComment(toAgentId)}\n\n本次没有提供上限数字。不要猜测数字、主动记忆或修改代码。交接后提交简短最终回复；后续完成通知只需确认，不要再次委派。`,
  });
  await mc.assign(user.token, ws, issue.id, fromAgentId);
  const deadline = Date.now() + timeout;
  const tasksOf = agentId => call(`/api/agents/${agentId}/tasks`);
  let { sender, receiver } = await firstReceiver({ tasksOf, issueId: issue.id, fromAgentId, toAgentId, timeout, grace, poll });
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
  const ok = result.status === 'completed' && /7\s*次|七次/.test(result.response) && result.recalls.some(r => r.run?.bound === true && r.entries?.some(e => e.scope === channelScope && result.response.includes(e.uri)));
  return { ok, records, detail: 'A second actual handoff omitted the number; B recovered the previous retry limit from its delegation channel and cited its URI' };
}

// REAL_AGENT_MATRIX_PHASE=history: only the second handoff, again, on a
// finished matrix's workspace and agents (its A to B channel is still there).
export async function recheckDelegationHistory({ mc, user, ws, report, agentTemplate, state, step, save }) {
  const id = role => report.agents?.find(a => a.role === role)?.id;
  const [fromAgentId, toAgentId] = [id('A'), id('B')];
  if (!fromAgentId || !toAgentId) throw new Error('The matrix has no A and B agents to hand off between');
  if (!report.tasks?.some(t => t.entry === 'delegation-receiver')) throw new Error('The first handoff never reached B: there is no delegation channel to recall');
  await mc.must('bind resumed B', mc.call(`/api/agents/${toAgentId}`, { method: 'PUT', token: user.token, ws, body: { runtime_id: agentTemplate.runtime_id } }));
  const history = await checkDelegationHistory({ mc, user, ws, fromAgentId, toAgentId, channelScope: `delegation:${ws}:${fromAgentId}:${toAgentId}`, state });
  report.tasks.push(...history.records);
  save();
  step('delegation-cross-task-recall', history.ok, history.detail);
  return history;
}
