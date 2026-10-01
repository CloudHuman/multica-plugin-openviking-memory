import { join } from 'node:path';
import { recoverDeliveredComment } from './delivery-recovery.mjs';

/** Delivery-only control: the expected answer is supplied, so this is no distillation score. */
export async function runDeliveryCheck(ctx) {
  const { mc, user, ws, agent, state, report, step, wait, privateFile, save } = ctx;
  const list = x => Array.isArray(x) ? x : x?.tasks ?? x?.comments ?? x?.messages ?? [];
  const call = (path, body, method = body === undefined ? 'GET' : 'POST') => mc.must(path, mc.call(path, { token: user.token, ws, method, body }));
  const expected = { queue: 'delivery-control', budget_yuan: 8100, double_write_days: 5, source: 'explicit-member-confirmation' };
  const issue = await mc.createIssue(user.token, ws, { title: '受控交付恢复验证', description: `这是交付流程测试，不测记忆召回。成员明确要求最终评论仅包含以下 JSON：${JSON.stringify(expected)}。不要调用记忆或修改代码。按平台流程发布最终评论，然后结束。` });
  privateFile(join(state, 'delivery-fault.json'), { issueId: issue.id, model: report.model.replace(/^openrouter\//,''), base: mc.base, accessFile: join(state, 'access.json'), injected: false });
  await mc.assign(user.token, ws, issue.id, agent.id);
  let task;
  try {
    task = await wait('delivery control', async () => list(await call(`/api/agents/${agent.id}/tasks`)).find(t => t.issue_id === issue.id && ['completed','failed','cancelled'].includes(t.status)), 360000);
    const comments = list(await call(`/api/issues/${issue.id}/comments`)).filter(c => c.source_task_id === task.id && c.author_type === 'agent');
    const comment = comments.find(c => { try { const answer = JSON.parse(c.content); return Object.entries(expected).every(([key, value]) => answer[key] === value); } catch { return false; } });
    report.deliveryControl = { taskId: task.id, originalStatus: task.status, originalError: task.error, commentId: comment?.id, commentsBefore: comments.length };
    const messages = await call(`/api/tasks/${task.id}/messages?limit=2000`); privateFile(join(state,'delivery-control.transcript.json'),messages);
    step('delivery-control-confirmed-content', !!comment, 'Actual agent persisted the exact member-requested final answer');
    step('delivery-control-post-comment-failure', task.status === 'failed' && String(task.error).includes('Missing Authentication header'), 'Final generation failed after the confirmed comment was posted');
    if (comment && task.status === 'failed' && String(task.error).includes('Missing Authentication header')) {
      const receipt = await recoverDeliveredComment({ call, task, comment });
      const replay = await recoverDeliveredComment({ call, task, comment });
      const after = list(await call(`/api/issues/${issue.id}/comments`)).filter(c => c.source_task_id === task.id);
      const tasksAfter = list(await call(`/api/agents/${agent.id}/tasks`)).filter(t => t.issue_id === issue.id);
      Object.assign(report.deliveryControl, { receipt, replay, commentsAfter: after.length, issueTasksAfter: tasksAfter.length });
      step('delivery-control-idempotent-recovery', receipt.status === 'completed' && receipt.recovered === true && replay.recovered === false && after.length === comments.length && tasksAfter.length === 1, 'Recovery reused the final comment, preserving the comment count and one task across repeated confirmation');
    }
    save();
  } finally {
    for (const active of list(await call(`/api/agents/${agent.id}/tasks`)).filter(t => t.issue_id === issue.id && !['completed','failed','cancelled'].includes(t.status))) await call(`/api/tasks/${active.id}/cancel`, {});
  }
}
