import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { auditMatrix } from './matrix.mjs';

// Continue the actual matrix after a native, unmonitored promotion failed.
// Replay its original archive; do not supply the expected facts to the agent.
export async function recoverSharedMatrix(ctx) {
  const { mc, ov, user, ws, report, pluginState, pluginUrl, pluginToken, agentTemplate, canary, issuePrefix, state, wait, step, save, privateFile, toolResultData } = ctx;
  const list = data => Array.isArray(data) ? data : data?.tasks ?? data?.comments ?? data?.messages ?? [];
  const call = (path, body, method = body === undefined ? 'GET' : 'POST') => mc.must(path, mc.call(path, { token: user.token, ws, body, method }));
  const scopes = () => JSON.parse(readFileSync(join(pluginState, 'scopes.json'), 'utf8')).scopes;
  const statuses = () => readFileSync(join(pluginState, 'archives.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const sharedScope = `shared:${ws}`;
  const sessionId = report.promotion?.sessionId;
  if (!sessionId) throw new Error('No original shared promotion exists');
  const rec = scopes()[sharedScope];
  report.promotionFailure = (await ov.listTasks(rec.apiKey, { resourceId: sessionId })).map(t => ({ taskId: t.task_id ?? t.id, status: t.status, error: t.error ?? null }));
  const replay = await fetch(`${pluginUrl}/admin/consolidate`, { method: 'POST', headers: { Authorization: `Bearer ${pluginToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id: ws, replay_session_id: sessionId }) });
  if (!replay.ok) throw new Error(`Shared recovery HTTP ${replay.status}: ${(await replay.text()).slice(0, 300)}`);
  report.promotionRecovery = (await replay.json()).result; save();
  const recovered = await wait('durable shared promotion recovery', async () => statuses().find(e => e.record === 'consolidate' && e.ref === sessionId && e.extraction === 'done'), 300000);
  report.promotionRecovery.events = statuses().filter(e => e.record === 'consolidate' && e.ref === sessionId);
  step('shared-extraction-failure-recovery', recovered.generation > 0 && report.promotionRecovery.events.some(e => e.extraction === 'redriven'), 'The actual failed shared extraction was durably replayed in a fresh session and completed');
  const tasksFor = agentId => call(`/api/agents/${agentId}/tasks?include_usage=true`);
  const bId = report.agents.find(a => a.role === 'B').id;
  await call(`/api/agents/${bId}`, { runtime_id: agentTemplate.runtime_id }, 'PUT');
  const issue = await mc.createIssue(user.token, ws, { title: `共享晋升后查询青岚方案 ${randomUUID().slice(0, 8)}`, description: '青岚仓库之前选定的中间件及成本上限是什么？请先调用 memory-recall，根据工作区共享记忆确认并引用来源 URI。本次没有提供答案或数值。不要修改代码或主动记录新记忆，按平台流程提交简短中文回复。' });
  await mc.assign(user.token, ws, issue.id, bId);
  const terminal = task => task && ['completed', 'failed', 'cancelled'].includes(task.status);
  let task = await wait('actual shared recall by B', async () => { const t = list(await tasksFor(bId)).find(t => t.issue_id === issue.id); return terminal(t) ? t : null; }, 360000);
  if (task.status === 'failed' && /Missing Authentication header/.test(task.error ?? '')) {
    report.providerErrors ??= [];
    report.providerErrors.push({ entry: 'shared-recall', taskId: task.id, operation: 'actual-agent-run', status: 401, message: task.error });
    const retry = await call(`/api/issues/${issue.id}/rerun`, { task_id: task.id });
    task = await wait('actual shared recall member rerun', async () => { const t = list(await tasksFor(bId)).find(t => t.id === retry.id); return terminal(t) ? t : null; }, 360000);
  }
  const messages = list(await call(`/api/tasks/${task.id}/messages`));
  const comments = list(await call(`/api/issues/${issue.id}/comments`)).filter(c => c.author_id === bId && c.source_task_id === task.id);
  const recalls = messages.filter(m => m.type === 'tool_result' && /memory.*recall/.test(m.tool ?? '')).map(toolResultData).filter(r => r?.status === 'ok').map(r => r.result);
  const response = [task.result?.output ?? '', ...comments.map(c => c.content)].join('\n');
  const record = { entry: 'shared-recall', taskId: task.id, agentId: bId, issueId: issue.id, status: task.status, error: task.error ?? null, startedAt: task.started_at, completedAt: task.completed_at, response, comments: comments.map(c => ({ id: c.id, sourceTaskId: c.source_task_id, content: c.content })), tools: messages.filter(m => m.type === 'tool_use').map(m => m.tool), recalls, usage: task.usage };
  report.tasks.push(record); privateFile(join(state, `shared-recall-${task.id}-transcript.json`), messages); save();
  step('multi-agent-shared-recall', task.status === 'completed' && /NATS/i.test(response) && /2450/.test(response) && recalls.some(r => r.run?.bound === true && r.entries?.some(e => e.scope === sharedScope && comments.some(c => c.content.includes(e.uri)))), 'Actual agent B recovered A business facts from the repaired shared memory and cited its URI in a persisted issue reply');
  for (const record of report.tasks) await wait(`archive ${record.entry}`, async () => statuses().find(e => e.record === 'archive-run' && e.ref === record.taskId && e.extraction === 'done'), 240000);
  await auditMatrix({ ov, report, scopes, statuses, canary, issuePrefix, step, save });
}
