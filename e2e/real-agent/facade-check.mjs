import { join } from 'node:path';
import { toolResultData } from './tool-output.mjs';
import { sleep } from '../real-stack/multica.mjs';

// Reusable both in the full matrix and against its still-running test daemon.
export async function checkFacade({ mc, user, ws, agentId, otherUri, state }) {
  if (process.env.MULTICA_RUN_REAL_AGENT_SMOKE !== '1') throw new Error('Explicit real-agent authorization is required');
  const call = path => mc.must(path, mc.call(path, { token: user.token, ws }));
  const issue = await mc.createIssue(user.token, ws, {
    title: '真实智能体原生记忆读取隔离验收',
    description: `这是明确授权的隔离边界测试。请先调用 memory-recall，再且只再调用一次 ov-read，uri 必须原样使用 ${otherUri} 。该 URI 属于另一个测试智能体；我们要确认工具是否拒绝。失败后如实说明，不要尝试绕过、搜索其他空间、主动记录公共记忆或修改代码。最后按平台流程提交简短回复，不要猜测文件内容。`,
  });
  await mc.assign(user.token, ws, issue.id, agentId);
  const deadline = Date.now() + 600000;
  let task;
  while (Date.now() < deadline) {
    task = (await call(`/api/agents/${agentId}/tasks`)).find(t => t.issue_id === issue.id);
    if (task && ['completed', 'failed', 'cancelled'].includes(task.status)) break;
    await sleep(1500);
  }
  if (!task || !['completed', 'failed', 'cancelled'].includes(task.status)) throw new Error(`Facade actual task ended ${task?.status ?? 'timeout'}`);
  const messages = await call(`/api/tasks/${task.id}/messages`);
  const attempted = messages.filter(m => m.type === 'tool_use' && /ov.*read/.test(m.tool ?? ''));
  const denied = messages.filter(m => m.type === 'tool_result' && /ov.*read/.test(m.tool ?? '')).map(toolResultData);
  const comments = (await call(`/api/issues/${issue.id}/comments`)).filter(c => c.author_id === agentId && c.source_task_id === task.id);
  const record = { entry: 'facade-boundary', taskId: task.id, agentId, issueId: issue.id, status: task.status, error: task.error ?? null, attempt: task.attempt, startedAt: task.started_at, completedAt: task.completed_at, response: [task.result?.output ?? '', ...comments.map(c => c.content)].join('\n'), tools: messages.filter(m => m.type === 'tool_use').map(m => m.tool), deniedResults: denied };
  if (state) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(state, `facade-boundary-${task.id}-transcript.json`), JSON.stringify(messages), { mode: 0o600 });
  }
  const ok = attempted.some(m => m.input?.uri === otherUri || m.input?.uris?.includes(otherUri)) && denied.some(d => d?.status === 'error' && /outside_own_space|forbidden|scope|not.allowed/i.test(JSON.stringify(d.error)));
  return { ok, record };
}
