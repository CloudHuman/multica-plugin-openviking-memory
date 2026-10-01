import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sleep } from '../real-stack/multica.mjs';

export async function checkDelegationHistory({ mc, user, ws, fromAgentId, toAgentId, channelScope, state }) {
  if (process.env.MULTICA_RUN_REAL_AGENT_SMOKE !== '1') throw new Error('Explicit real-agent authorization is required');
  const call = path => mc.must(path, mc.call(path, { token: user.token, ws }));
  const issue = await mc.createIssue(user.token, ws, {
    title: `新任务查询雨燕历史交接约定 ${randomUUID().slice(0, 8)}`,
    description: `这是一次新的、明确授权的历史交接查询。先调用 memory-recall，再实际发布且只发布一次给复核智能体的评论，包含 [@复核智能体](mention://agent/${toAgentId}) 以及问题“雨燕项目之前确定的重试上限是多少？请调用 memory-recall 查询 A 到 B 委派通道，回答并引用来源 URI”。本次没有提供上限数字。不要猜测数字、主动记忆或修改代码。交接后提交简短最终回复；后续完成通知只需确认，不要再次委派。`,
  });
  await mc.assign(user.token, ws, issue.id, fromAgentId);
  const deadline = Date.now() + 600000;
  let sender, receiver;
  while (Date.now() < deadline) {
    sender = (await call(`/api/agents/${fromAgentId}/tasks`)).find(t => t.issue_id === issue.id);
    receiver = (await call(`/api/agents/${toAgentId}/tasks`)).find(t => t.issue_id === issue.id);
    if (receiver && ['completed', 'failed', 'cancelled'].includes(receiver.status)) break;
    if (sender?.status === 'failed' && !receiver) throw new Error(`History delegation sender failed: ${sender.error}`);
    await sleep(1500);
  }
  if (!receiver) throw new Error('History delegation did not dispatch the receiver');
  const records = [];
  for (const [role, task] of [['sender', sender], ['receiver', receiver]]) {
    const messages = await call(`/api/tasks/${task.id}/messages`);
    const comments = (await call(`/api/issues/${issue.id}/comments`)).filter(c => c.author_id === task.agent_id && c.source_task_id === task.id);
    const recalls = messages.filter(m => m.type === 'tool_result' && /memory.*recall/.test(m.tool ?? '')).map(m => { try { return JSON.parse(m.output).result; } catch { return null; } }).filter(Boolean);
    const record = { entry: `delegation-history-${role}`, taskId: task.id, agentId: task.agent_id, issueId: issue.id, status: task.status, error: task.error ?? null, startedAt: task.started_at, completedAt: task.completed_at, response: [task.result?.output ?? '', ...comments.map(c => c.content)].join('\n'), tools: messages.filter(m => m.type === 'tool_use').map(m => m.tool), recalls };
    records.push(record);
    if (state) writeFileSync(join(state, `${record.entry}-${task.id}-transcript.json`), JSON.stringify(messages), { mode: 0o600 });
  }
  const result = records[1];
  const ok = result.status === 'completed' && /7\s*次|七次/.test(result.response) && result.recalls.some(r => r.run?.bound === true && r.entries?.some(e => e.scope === channelScope && result.response.includes(e.uri)));
  return { ok, records };
}
