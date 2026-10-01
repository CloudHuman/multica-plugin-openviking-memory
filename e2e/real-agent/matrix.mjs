import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { auditMemories } from './memory-audit.mjs';

// All task transcripts and tool calls are produced by the official daemon.
// The harness only sends member input, waits, and inspects persisted evidence.
export async function runMatrix(ctx) {
  const { mc, ov, user, ws, agent: a, agentTemplate, state, pluginState, pluginUrl, pluginToken, canary, run, report, step, save, wait, privateFile, toolResultData } = ctx;
  const list = data => Array.isArray(data) ? data : data?.tasks ?? data?.messages ?? data?.comments ?? data?.issues ?? data?.runs ?? data?.autopilots ?? [];
  const call = (path, body, method = body === undefined ? 'GET' : 'POST') => mc.must(path, mc.call(path, { token: user.token, ws, method, body }));
  const b = ctx.resume
    ? await call(`/api/agents/${report.agents.find(a => a.role === 'B').id}`, { runtime_id: agentTemplate.runtime_id }, 'PUT')
    : await call('/api/agents', { ...agentTemplate, name: `Real memory reviewer ${run}` });
  report.agents = [{ id: a.id, role: 'A' }, { id: b.id, role: 'B' }];
  report.tasks ??= []; report.limitations ??= []; save();
  const scopes = () => existsSync(join(pluginState, 'scopes.json')) ? JSON.parse(readFileSync(join(pluginState, 'scopes.json'), 'utf8')).scopes : {};
  const statuses = () => existsSync(join(pluginState, 'archives.jsonl')) ? readFileSync(join(pluginState, 'archives.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  const tasks = async agent => list(await call(`/api/agents/${agent.id}/tasks?include_usage=true`));
  const matchesRun = (task, run) => !!run.task_id && task.id === run.task_id
    || [run.run_id, run.id, run.run?.id].filter(Boolean).some(id => task.autopilot_run_id === id)
    || !!run.issue_id && task.issue_id === run.issue_id;
  const tools = result => result.messages.filter(m => m.type === 'tool_result').map(m => ({ tool: m.tool, data: toolResultData(m) }));
  const recalls = result => tools(result).filter(r => /memory.*recall/.test(r.tool ?? '') && r.data?.status === 'ok').map(r => r.data.result);
  const cited = (result, scope) => recalls(result).some(r => r.run?.bound === true && r.entries?.some(e => e.scope === scope && result.response.includes(e.uri)));
  const noPrivateScope = (result, scope) => recalls(result).length > 0 && recalls(result).every(r => !r.scopesSearched?.some(s => s.scope === scope) && !r.entries?.some(e => e.scope === scope));
  async function capture(task, entry) {
    const messages = list(await call(`/api/tasks/${task.id}/messages?limit=2000`));
    const comments = task.issue_id ? list(await call(`/api/issues/${task.issue_id}/comments`)).filter(c => c.author_type === 'agent' && c.author_id === task.agent_id && c.source_task_id === task.id) : [];
    const chatReplies = task.chat_session_id ? list(await call(`/api/chat/sessions/${task.chat_session_id}/messages`)).filter(m => m.role === 'assistant' && m.task_id === task.id) : [];
    const response = [task.result?.output ?? '', ...comments.map(c => c.content), ...chatReplies.map(m => m.content), ...messages.filter(m => m.type === 'text').map(m => m.content ?? '')].join('\n');
    const record = { entry, taskId: task.id, agentId: task.agent_id, issueId: task.issue_id || null, chatSessionId: task.chat_session_id || null, status: task.status, attempt: task.attempt, retryOfTaskId: task.retry_of_task_id || null, startedAt: task.started_at, completedAt: task.completed_at, response, comments: comments.map(c => ({ id: c.id, content: c.content, sourceTaskId: c.source_task_id })), tools: messages.filter(m => m.type === 'tool_use').map(m => m.tool), recalls: recalls({ messages }), usage: task.usage };
    privateFile(join(state, `${entry}-${task.id}-transcript.json`), messages);
    report.tasks.push(record); save();
    if (task.chat_session_id) { record.chatReplies = chatReplies.map(m => ({ id: m.id, content: m.content, taskId: m.task_id })); save(); }
    console.log(`${entry}: ${task.status}`);
    if (task.status !== 'completed') throw new Error(`${entry}: real agent ended ${task.status}: ${String(task.error ?? '').slice(0, 400)}`);
    return { task, messages, response, record };
  }
  async function completed(agent, match, entry) {
    let status;
    let targetId;
    const resolve = () => wait(entry, async () => {
      const t = (await tasks(agent)).find(targetId ? t => t.id === targetId : match);
      if (t && status !== t.status) { status = t.status; console.log(`${entry}: ${status}`); }
      return t && ['completed', 'failed', 'cancelled'].includes(t.status) ? t : null;
    }, 600000);
    let task = await resolve();
    if (task.status === 'failed' && task.issue_id && /Missing Authentication header/.test(task.error ?? '') && entry !== 'delegation-receiver') {
      report.providerErrors ??= [];
      report.providerErrors.push({ entry, operation: 'actual-agent-run', taskId: task.id, status: 401, message: task.error, ts: new Date().toISOString() });
      const messages = list(await call(`/api/tasks/${task.id}/messages`));
      privateFile(join(state, `${entry}-failed-${task.id}-transcript.json`), messages);
      console.log(`RETRY ${entry}: actual model authentication error; one member rerun, unchanged credential and model`);
      const rerun = await call(`/api/issues/${task.issue_id}/rerun`, { task_id: task.id });
      targetId = rerun.id;
      status = undefined;
      task = await resolve();
    }
    return capture(task, entry);
  }
  async function issueRun(agent, title, description, entry) {
    const issue = await mc.createIssue(user.token, ws, { title, description });
    await mc.assign(user.token, ws, issue.id, agent.id);
    const result = await completed(agent, t => t.issue_id === issue.id, entry);
    return { ...result, issue };
  }
  async function extracted(taskId, expectedScope) {
    const event = await wait(`extraction ${taskId}`, async () => statuses().find(e => e.type === 'extraction' && e.record === 'archive-run' && e.ref === taskId && e.extraction === 'done'), 240000);
    step(`archive-${report.tasks.find(t => t.taskId === taskId)?.entry ?? taskId}`, event.scope === expectedScope, `Automatic archive and extraction in ${event.scope}`);
    return event;
  }
  async function searchable(scope, query, pattern) {
    let authRetries = 0;
    return wait(`searchable ${scope}`, async () => {
      const rec = scopes()[scope];
      if (!rec) return null;
      let result;
      try { result = await ov.search(rec.apiKey, { query, limit: 10 }); }
      catch (error) {
        // Diagnostic retries are recorded; a pass never establishes provider
        // stability. Do not change credentials or retry a persistent refusal.
        if (error.status !== 401 || authRetries++ >= 2) throw error;
        report.providerErrors ??= [];
        report.providerErrors.push({ scope, operation: 'fixture-readiness-search', status: 401, message: error.message, ts: new Date().toISOString() });
        save();
        return null;
      }
      const hits = result.memories ?? [];
      const content = (await Promise.all(hits.filter(h => h.context_type === 'memory').map(h => ov.readContent(rec.apiKey, h.uri).then(r => r.content ?? '').catch(() => '')))).join('\n');
      return pattern.test(content) ? { hits, content } : null;
    }, 180000);
  }
  async function chatRun(agent, title, content, entry) {
    const session = await call('/api/chat/sessions', { agent_id: agent.id, title });
    const sent = await call(`/api/chat/sessions/${session.id}/messages`, { content });
    const result = await completed(agent, t => t.id === sent.task_id, entry);
    return { ...result, session, sent };
  }
  const finish = '请先调用 memory-recall，按实际证据回复。不要修改代码，除明确要求外不要主动记录记忆。按平台流程提交简短回复，引用召回的来源 URI。';
  const publicScopeA = `agent:${ws}:${a.id}`;
  if (!ctx.resume) {
  const publicSeed = await issueRun(a, '青岚仓库的可复用约定', `青岚仓库确认采用 NATS JetStream，每月成本上限 2450 元。${finish} 请使用 memory-remember 将这两项业务约定主动记为一条 cases 公共记忆。`, 'agent-public-seed');
  step('active-write-agent-A', tools(publicSeed).some(r => /memory.*remember/.test(r.tool ?? '') && r.data?.status === 'ok'), 'Actual agent A wrote its reusable business memory');
  await searchable(publicScopeA, '青岚 NATS 2450', /2450/);
  const isolated = await issueRun(b, '独立智能体查询青岚方案', `青岚仓库之前选定的中间件及成本上限是什么？${finish} 没有证据时如实说明，不要猜测。`, 'agent-isolation');
  step('agent-public-isolation', noPrivateScope(isolated, publicScopeA) && !/2450/.test(isolated.response) && /没有|未找到|无相关|无法确认|暂无/.test(isolated.response), 'Actual agent B could not search or reproduce A public memory before promotion');
  const activeMemoryUri = tools(publicSeed).find(r => /memory.*remember/.test(r.tool ?? '') && r.data?.status === 'ok')?.data?.result?.uri;
  if (!activeMemoryUri) throw new Error('Actual A remember did not return a source URI');
  const { checkFacade } = await import('./facade-check.mjs');
  const boundary = await checkFacade({ mc, user, ws, agentId: b.id, otherUri: activeMemoryUri, state });
  report.tasks.push(boundary.record);
  step('actual-facade-cross-agent-denial', boundary.ok, 'The actual B agent attempted ov-read against A URI and the facade refused it');
  if (boundary.record.status !== 'completed') {
    report.limitations.push({ entry: 'facade-boundary-delivery', status: boundary.record.status, reason: boundary.record.error, taskId: boundary.record.taskId });
    save();
  }

  const collaboration = await issueRun(a, '苍鹭发布方案交接', `成员本次正式确认苍鹭发布使用 Apache Pulsar，每月预算 7600 元，双写持续五天。请先调用 memory-recall 查历史，再以本次成员确认作为新事实的直接证据，简短确认三项约定。历史为空或只有别的项目记忆时，不能因此否定本次确认。不要主动写入公共记忆，不要修改代码，按平台流程提交回复。`, 'collaboration-seed');
  const taskScope = `task:${ws}:${collaboration.issue.id}`;
  await extracted(collaboration.task.id, taskScope);
  await searchable(taskScope, '苍鹭发布预算与双写', /7600/);
  await call(`/api/issues/${collaboration.issue.id}`, { description: `苍鹭发布之前确定的队列、预算与双写周期是什么？${finish} 数值没有在本次描述提供，请依据召回证据。`, assignee_type: 'agent', assignee_id: b.id }, 'PUT');
  const collaborator = await completed(b, t => t.issue_id === collaboration.issue.id, 'collaboration-recall');
  step('multi-agent-collaboration', cited(collaborator, taskScope) && /Pulsar/i.test(collaborator.response) && /7600/.test(collaborator.response) && /五天|5\s*天/.test(collaborator.response), 'Actual agent B recovered A task archive after issue reassignment and cited its URI');
  const previousB = new Set((await tasks(b)).map(t => t.id));
  const feedback = await mc.comment(user.token, ws, collaboration.issue.id, `新的正式要求：苍鹭发布预算调整为 8100 元，其他约定不变。${finish} 明确以本次更新为准。`);
  const followed = await completed(b, t => t.issue_id === collaboration.issue.id && !previousB.has(t.id), 'member-feedback');
  step('member-comment-follow-up', recalls(followed).some(r => r.run?.bound === true) && /8100/.test(followed.response), 'A real member comment started a follow-up; the agent recalled context and applied the new budget');
  report.feedbackCommentId = feedback.id;
  const rerun = await call(`/api/issues/${collaboration.issue.id}/rerun`, { task_id: followed.task.id });
  const rerunResult = await completed(b, t => t.id === (rerun.id ?? rerun.task_id), 'manual-rerun');
  step('manual-rerun-recalls-issue', recalls(rerunResult).some(r => r.run?.bound === true && r.scopesSearched?.some(s => s.scope === taskScope)), 'An actual member rerun retained the issue memory scope');
  const wakeup = await call(`/api/issues/${collaboration.issue.id}/wakeups`, { agent_id: b.id, kind: 'at', at: new Date(Date.now() + 86400000).toISOString(), instruction: `执行一次苍鹭业务复核。${finish} 只确认有证据的预算，不要再创建唤醒规则。` });
  try {
    const beforeWakeup = new Set((await tasks(b)).map(t => t.id));
    await call(`/api/issues/${collaboration.issue.id}/wakeups/${wakeup.id}/trigger`, {});
    const wakeupResult = await completed(b, t => t.issue_id === collaboration.issue.id && !beforeWakeup.has(t.id), 'manual-wakeup');
    step('wakeup-recalls-issue', recalls(wakeupResult).some(r => r.run?.bound === true && r.scopesSearched?.some(s => s.scope === taskScope)), 'An actual wake-now run retained the issue memory scope');
  } finally {
    await call(`/api/issues/${collaboration.issue.id}/wakeups/${wakeup.id}`, undefined, 'DELETE');
  }

  const delegated = await issueRun(a, '雨燕交接给复核智能体', `这是一次明确授权的多智能体交接测试。请先调用 memory-recall，然后实际用 multica issue comment add 在当前 issue 发布且只发布一次给复核智能体的交接评论。评论必须包含完整 mention：[@复核智能体](mention://agent/${b.id})，以及业务交接事实“雨燕项目重试上限为 7 次，请据此复核并引用记忆来源”。不要在这次运行直接回答复核问题。交接后提交简短最终回复；后续完成通知只需确认，不要再次委派。不要修改代码或主动写公共记忆。`, 'delegation-sender');
  const receiver = await completed(b, t => t.issue_id === delegated.issue.id, 'delegation-receiver');
  const channel = `delegation:${ws}:${a.id}:${b.id}`;
  step('real-delegation-linked', recalls(receiver).some(r => r.run?.bound === true && r.scopesSearched?.some(s => s.scope === channel)), 'Actual A mention dispatched B with its delegation channel in recall scopes');
  await extracted(receiver.task.id, `task:${ws}:${delegated.issue.id}`);
  const channelEvent = await wait('actual delegation archive', async () => statuses().find(e => e.record === 'archive-delegation' && e.ref === receiver.task.id && e.extraction === 'done'), 45000).catch(() => null);
  step('real-delegation-archive', !!channelEvent && channelEvent.scope === channel, 'The actual agent-authored handoff was archived and extracted in A to B channel');
  const { checkDelegationHistory } = await import('./delegation-check.mjs');
  const history = await checkDelegationHistory({ mc, user, ws, fromAgentId: a.id, toAgentId: b.id, channelScope: channel, state });
  report.tasks.push(...history.records);
  step('delegation-cross-task-recall', history.ok, 'A second actual handoff omitted the number; B recovered the previous retry limit from its delegation channel and cited its URI');

  const dmScope = `dm:${ws}:${a.id}:${user.userId}`;
  const chatSeed = await chatRun(a, '私人周报排版', `蓝鹊周报是我的私人排版约定：固定按“风险、进展、下一步”三个中文标题，风险放第一。请先调用 memory-recall，再简短确认；这是私聊内容，不要写入公共记忆，不要创建 issue 或修改代码。`, 'chat-seed');
  await extracted(chatSeed.task.id, dmScope);
  await searchable(dmScope, '蓝鹊周报私人格式', /风险/);
  const chatRecall = await chatRun(a, '新会话查询既有偏好', `蓝鹊周报之前约定的三个标题及顺序是什么？${finish} 这是新会话，本次没有提供原始格式，请从记忆确认；不要创建 issue。`, 'chat-recall');
  step('new-chat-pair-recall', cited(chatRecall, dmScope) && /风险[\s\S]*进展[\s\S]*下一步/.test(chatRecall.response), 'A new real chat session recalled the same member and agent private pair memory');
  const chatOther = await chatRun(b, '另一个智能体查询偏好', `蓝鹊周报之前约定的私人标题及顺序是什么？${finish} 没有证据请如实说明，不要猜测或创建 issue。`, 'chat-pair-isolation');
  step('chat-pair-isolation', noPrivateScope(chatOther, dmScope) && /没有|未找到|无相关|无法确认|暂无/.test(chatOther.response), 'The other actual agent did not search the A/member private conversation');
  } else if (!ctx.finish) {
    const { checkDelegationHistory } = await import('./delegation-check.mjs');
    const history = await checkDelegationHistory({ mc, user, ws, fromAgentId: a.id, toAgentId: b.id, channelScope: `delegation:${ws}:${a.id}:${b.id}`, state });
    report.tasks.push(...history.records);
    step('delegation-cross-task-recall', history.ok, 'A second actual handoff omitted the number; B recovered the previous retry limit from its delegation channel and cited its URI');
    for (const record of report.tasks.filter(t => t.chatSessionId)) {
      record.chatReplies = list(await call(`/api/chat/sessions/${record.chatSessionId}/messages`)).filter(m => m.role === 'assistant' && m.task_id === record.taskId).map(m => ({ id: m.id, content: m.content, taskId: m.task_id }));
    }
    step('actual-chat-replies-persisted', report.tasks.filter(t => t.chatSessionId).every(t => t.chatReplies?.some(m => m.content && m.taskId === t.taskId)), 'All three original chat runs have actual persisted assistant replies linked to their task');
  }

  const quickTitle = `金雀发布回归 ${run}${ctx.finish ? ` 修复验证 ${randomUUID().slice(0, 8)}` : ''}`;
  const quick = await call('/api/issues/quick-create', { agent_id: a.id, prompt: `创建一个任务，标题必须是“${quickTitle}”，描述必须包含“回归窗口七天，回滚演练最长三小时”。创建前先调用 memory-recall，完成后回复新 issue 编号。不要主动记录公共记忆，不要修改代码。` });
  const quickResult = await completed(a, t => t.id === quick.task_id, 'quick-create');
  const createdIssues = list(await call('/api/issues?limit=100'));
  // The member issue list omits origin_id/origin_type. The persisted task
  // links to the actual created issue; recall supplies its trusted run kind.
  const created = createdIssues.find(i => i.id === quickResult.task.issue_id && i.title === quickTitle && i.creator_id === a.id);
  step('quick-create-actual-issue', !!created && /七天/.test(created.description ?? '') && /三小时/.test(created.description ?? '') && recalls(quickResult).some(r => r.run?.kind === 'quick_create' && r.run?.bound === true), 'The actual quick-create agent produced the requested issue linked to its actual run');
  await extracted(quickResult.task.id, `run:${ws}:${quickResult.task.id}`);

  let automationScope, scheduled;
  if (!ctx.finish) {
    const autopilot = await call('/api/autopilots', { title: `黄鹂巡检 ${run}`, assignee_id: a.id, execution_mode: 'run_only', description: `成员本次正式确认黄鹂巡检的固定业务阈值是错误率超过 3.5% 时告警。请先调用 memory-recall 查历史，再以本次确认作为直接证据，简短确认 3.5% 阈值。历史为空也不能否定本次明确确认。不要创建 issue、外部通知或主动记忆。` });
    const autoRun = await call(`/api/autopilots/${autopilot.id}/trigger`, {});
    const autoSeed = await completed(a, t => matchesRun(t, autoRun), 'autopilot-seed');
    automationScope = `automation:${ws}:${autopilot.id}`;
    await extracted(autoSeed.task.id, automationScope);
    await searchable(automationScope, '黄鹂巡检错误率阈值', /3\.5/);
    await call(`/api/autopilots/${autopilot.id}`, { description: `黄鹂巡检之前确定的错误率告警阈值是什么？${finish} 本次没有提供数字。不要创建 issue、外部通知或主动记忆。` }, 'PATCH');
    const autoAgain = await call(`/api/autopilots/${autopilot.id}/trigger`, {});
    const autoRecall = await completed(a, t => matchesRun(t, autoAgain), 'autopilot-recall');
    step('autopilot-cross-run-recall', cited(autoRecall, automationScope) && /3\.5/.test(autoRecall.response), 'A second actual run-only autopilot recovered the previous threshold from its own automation memory');
    const webhook = await call(`/api/autopilots/${autopilot.id}/triggers`, { kind: 'webhook', provider: 'generic', label: 'Isolated local webhook verification' });
    try {
      const delivery = await fetch(`${mc.base}${webhook.webhook_path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ event: 'local.memory.verification', description: 'Authorized isolated local test, no external delivery' }) });
      if (!delivery.ok) throw new Error(`Local autopilot webhook HTTP ${delivery.status}`);
      const deliveryRun = await delivery.json();
      report.webhookDelivery = { taskId: deliveryRun.task_id, runId: deliveryRun.run_id ?? deliveryRun.id ?? deliveryRun.run?.id }; save();
      const webhookResult = await completed(a, t => matchesRun(t, deliveryRun), 'autopilot-webhook');
      step('autopilot-webhook-recall', cited(webhookResult, automationScope) && /3\.5/.test(webhookResult.response), 'A real local webhook dispatched an actual agent with the same automation memory scope');
    } finally {
      await call(`/api/autopilots/${autopilot.id}/triggers/${webhook.id}`, undefined, 'DELETE');
    }
    await call(`/api/autopilots/${autopilot.id}`, { status: 'paused' }, 'PATCH');
    scheduled = await call('/api/autopilots', { title: `银鸥定时巡检 ${run}`, assignee_id: b.id, execution_mode: 'run_only', description: `成员本次正式确认银鸥巡检的业务请求上限为每批 23 条。请先调用 memory-recall，再以本次确认作为直接证据回复 23 条上限。不要创建 issue、唤醒规则、外部通知或主动记忆。` });
    const scheduleTrigger = await call(`/api/autopilots/${scheduled.id}/triggers`, { kind: 'schedule', cron_expression: '* * * * *', timezone: 'UTC', label: 'One scheduled test run' });
    try {
      const scheduledRun = await wait('actual cron dispatch', async () => list(await call(`/api/autopilots/${scheduled.id}/runs`))[0], 120000);
      await call(`/api/autopilots/${scheduled.id}`, { status: 'paused' }, 'PATCH');
      const scheduledResult = await completed(b, t => matchesRun(t, scheduledRun), 'autopilot-schedule');
      step('autopilot-schedule-actual-run', /23/.test(scheduledResult.response) && recalls(scheduledResult).some(r => r.run?.bound === true && r.scopesSearched?.some(s => s.scope === `automation:${ws}:${scheduled.id}`)), 'The real scheduler dispatched and completed a correctly scoped actual agent run');
    } finally {
      await call(`/api/autopilots/${scheduled.id}/triggers/${scheduleTrigger.id}`, undefined, 'DELETE');
      await call(`/api/autopilots/${scheduled.id}`, { status: 'paused' }, 'PATCH');
    }
    const createsIssue = await call('/api/autopilots', { title: `赤鹭创建巡检任务 ${run}`, assignee_id: b.id, execution_mode: 'create_issue', issue_title_template: `赤鹭巡检 ${run}`, description: `成员本次正式确认赤鹭巡检回滚演练不超过 45 分钟。请先调用 memory-recall，再以本次确认作为直接证据回复 45 分钟上限。不要另建 issue、外部通知或主动记忆。` });
    try {
      const issueAutoRun = await call(`/api/autopilots/${createsIssue.id}/trigger`, {});
      const issueAutoResult = await completed(b, t => matchesRun(t, issueAutoRun), 'autopilot-create-issue');
      step('autopilot-create-issue-memory', !!issueAutoResult.task.issue_id && /45/.test(issueAutoResult.response) && recalls(issueAutoResult).some(r => r.run?.kind === 'issue' && r.scopesSearched?.some(s => s.scope === `task:${ws}:${issueAutoResult.task.issue_id}`)), 'An actual create-issue autopilot used the created issue collaboration scope');
    } finally {
      await call(`/api/autopilots/${createsIssue.id}`, { status: 'paused' }, 'PATCH');
    }
  } else {
    const automations = list(await call('/api/autopilots'));
    const autopilot = automations.find(auto => auto.title === `黄鹂巡检 ${run}` && auto.assignee_id === a.id);
    scheduled = automations.find(auto => auto.title === `银鸥定时巡检 ${run}` && auto.assignee_id === b.id);
    const createsIssue = automations.find(auto => auto.title === `赤鹭创建巡检任务 ${run}` && auto.assignee_id === b.id);
    if (!autopilot || !scheduled || !createsIssue) throw new Error('Finish phase requires the original three test automations');
    automationScope = `automation:${ws}:${autopilot.id}`;
    const webhookRun = list(await call(`/api/autopilots/${autopilot.id}/runs`)).find(r => r.source === 'webhook');
    if (!webhookRun?.task_id) throw new Error('No actual webhook task was persisted');
    const webhookResult = await completed(a, t => t.id === webhookRun.task_id, 'autopilot-webhook');
    for (const record of report.tasks.filter(t => t.entry === 'autopilot-webhook' && t.taskId !== webhookRun.task_id)) {
      record.originalValidatorEntry = record.entry; record.entry = 'quick-create-follow-up';
    }
    step('autopilot-webhook-recall', cited(webhookResult, automationScope) && /3\.5/.test(webhookResult.response), 'Matched the real persisted webhook run ID and actual task; the response recovered the threshold and cited automation memory');
    report.validatorCorrections ??= [];
    report.validatorCorrections.push({ entry: 'autopilot-webhook', reason: 'Missing run identifiers previously matched an unrelated task; fixed by requiring nonempty IDs and inspecting the persisted webhook run', runId: webhookRun.id, taskId: webhookResult.task.id });
    report.validatorCorrections.push({ entry: 'quick-create-actual-issue', reason: 'The member issue list omits origin fields; verify the task to created-issue link, creator, business content and bound quick-create recall instead' });
    const issueAutoRun = list(await call(`/api/autopilots/${createsIssue.id}/runs`))[0];
    const issueAutoResult = await completed(b, t => matchesRun(t, issueAutoRun), 'autopilot-create-issue');
    step('autopilot-create-issue-memory', !!issueAutoResult.task.issue_id && /45/.test(issueAutoResult.response) && recalls(issueAutoResult).some(r => r.run?.kind === 'issue' && r.scopesSearched?.some(s => s.scope === `task:${ws}:${issueAutoResult.task.issue_id}`)), 'Matched the created issue ID because create-issue automations do not expose a direct task ID; the actual agent used the issue collaboration scope');
    for (const auto of [autopilot, scheduled, createsIssue]) await call(`/api/autopilots/${auto.id}`, { status: 'paused' }, 'PATCH');
  }

  await wait('agents idle before concurrency check', async () => !(await tasks(a)).concat(await tasks(b)).some(t => ['queued', 'running'].includes(t.status)), 120000);

  const both = await Promise.all([
    mc.createIssue(user.token, ws, { title: '并发 A 独立业务', description: `成员本次正式确认 A 并发业务标记为 ALPHA_ONLY_${run}。请先调用 memory-recall，再确认本次明确提供的标记。历史为空不影响本次事实，不要写公共记忆或修改代码。` }),
    mc.createIssue(user.token, ws, { title: '并发 B 独立业务', description: `成员本次正式确认 B 并发业务标记为 BETA_ONLY_${run}。请先调用 memory-recall，再确认本次明确提供的标记。历史为空不影响本次事实，不要写公共记忆或修改代码。` }),
  ]);
  await mc.assign(user.token, ws, both[0].id, a.id);
  await mc.assign(user.token, ws, both[1].id, b.id);
  const running = await wait('running issue for supplement capability', async () => (await tasks(a)).find(t => t.issue_id === both[0].id && t.status === 'running'), 90000);
  const supplement = await mc.call(`/api/issues/${both[0].id}/tasks/${running.id}/supplements`, { token: user.token, ws, method: 'POST', body: { client_request_id: randomUUID(), content: `追加验收标记 SUPPLEMENT_ONLY_${run}，请按新要求再召回。` } });
  if (supplement.status === 412) {
    report.limitations.push({ entry: 'running-task-supplement', status: 'unsupported', httpStatus: 412, reason: supplement.json?.code ?? supplement.json?.error ?? 'Current OpenCode runtime does not support in-flight supplements' });
    console.log('LIMIT running-task-supplement: real API rejected unsupported OpenCode turn with HTTP 412');
    save();
  } else if (supplement.status >= 300) throw new Error(`Unexpected supplement status ${supplement.status}: ${supplement.text.slice(0, 300)}`);
  const concurrent = await Promise.all([completed(a, t => t.issue_id === both[0].id, 'concurrent-A'), completed(b, t => t.issue_id === both[1].id, 'concurrent-B')]);
  const overlap = Math.max(...concurrent.map(r => Date.parse(r.task.started_at))) < Math.min(...concurrent.map(r => Date.parse(r.task.completed_at)));
  step('actual-parallel-runs-isolated', overlap && concurrent.every((r, i) => recalls(r).some(q => q.run?.bound === true && q.scopesSearched?.some(s => s.scope === `task:${ws}:${r.task.issue_id}`) && !q.scopesSearched?.some(s => s.scope === `task:${ws}:${both[1 - i].id}`)) && r.response.includes(`${i ? 'BETA' : 'ALPHA'}_ONLY_${run}`) && !r.response.includes(`${i ? 'ALPHA' : 'BETA'}_ONLY_${run}`)), 'Actual A and B execution intervals overlapped; recall and final business markers remained bound to the correct task');
  if (supplement.status < 300) step('running-task-supplement-delivered', concurrent[0].response.includes(`SUPPLEMENT_ONLY_${run}`), 'Actual running agent incorporated the supplemental member input');

  // Shared promotion is a real administrator operation, never a fake agent call.
  const promoteResponse = await fetch(`${pluginUrl}/admin/consolidate`, { method: 'POST', headers: { Authorization: `Bearer ${pluginToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id: ws, per_scope_limit: 8 }) });
  if (!promoteResponse.ok) throw new Error(`Shared promotion HTTP ${promoteResponse.status}`);
  const promoted = (await promoteResponse.json()).result;
  report.promotion = { sources: promoted.sources, promoted: promoted.promoted, sessionId: promoted.session_id, jobId: promoted.job_id, status: promoted.status };
  step('shared-promotion-excludes-private-chat', promoted.promoted?.some(p => p.from === publicScopeA) && promoted.promoted.every(p => /^(agent|task):/.test(p.from)), 'Administrator promotion took only agent-public and task memories, never private chat scopes');
  const sharedScope = `shared:${ws}`;
  await wait('durable shared extraction', async () => statuses().find(e => e.record === 'consolidate' && e.ref === promoted.session_id && e.extraction === 'done'), 300000);
  await searchable(sharedScope, '青岚仓库中间件成本上限', /2450/);
  const sharedRecall = await issueRun(b, '共享晋升后查询青岚方案', `青岚仓库之前选定的中间件及成本上限是什么？${finish} 根据工作区共享记忆确认。`, 'shared-recall');
  step('multi-agent-shared-recall', cited(sharedRecall, sharedScope) && /NATS/i.test(sharedRecall.response) && /2450/.test(sharedRecall.response), 'Actual agent B recovered A reusable business facts through explicitly promoted shared memory');

  for (const record of report.tasks) {
    const expected = record.entry.startsWith('chat-') ? `dm:${ws}:${record.agentId}:${user.userId}` : record.entry === 'autopilot-schedule' ? `automation:${ws}:${scheduled.id}` : record.entry.startsWith('autopilot-') && record.entry !== 'autopilot-create-issue' ? automationScope : record.entry === 'quick-create' ? `run:${ws}:${record.taskId}` : `task:${ws}:${record.issueId}`;
    if (!statuses().some(e => e.ref === record.taskId && e.record === 'archive-run' && e.extraction === 'done')) await extracted(record.taskId, expected);
  }
  await auditMatrix({ ov, report, scopes, statuses, canary, step, save });
}

export async function auditMatrix({ ov, report, scopes, statuses, canary, step, save }) {
  const archiveAudit = [];
  const taskIds = new Set(report.tasks.map(t => t.taskId));
  for (const event of statuses().filter(e => e.type === 'extraction' && e.extraction === 'done' && taskIds.has(e.ref))) {
    const rec = scopes()[event.scope];
    const uri = `viking://user/${rec.userId}/sessions/${event.session_id}/history/archive_001/messages.jsonl`;
    if (archiveAudit.some(audit => audit.uri === uri)) continue;
    const content = (await ov.readContent(rec.apiKey, uri, { limit: 5000 })).content ?? '';
    archiveAudit.push({ taskId: event.ref, scope: event.scope, uri, characters: content.length, containsPlatformCanary: content.includes(canary), containsRuntimeBanner: content.includes('# Multica Agent Runtime') });
  }
  report.archiveAudit = archiveAudit;
  step('matrix-archive-prompt-hygiene', archiveAudit.length >= taskIds.size && archiveAudit.every(audit => audit.characters > 0 && !audit.containsPlatformCanary && !audit.containsRuntimeBanner), `Inspected ${archiveAudit.length} actual task and delegation archives`);
  const memoryAudit = await auditMemories({ ov, scopes: scopes(), canary });
  report.memoryAudit = memoryAudit;
  step('matrix-prompt-hygiene', memoryAudit.some(audit => audit.files > 0) && memoryAudit.every(audit => audit.complete && !audit.containsPlatformCanary && !audit.containsRuntimeBanner && !audit.containsPlatformGuidance), `Inspected ${memoryAudit.reduce((n, audit) => n + audit.files, 0)} extracted memory files including peer namespaces`);
  step('matrix-memory-quality', memoryAudit.every(audit => audit.complete && !audit.qualityFindings.length), 'Reusable memories checked for known execution controls, search-outcome facts and platform scaffolding (bounded rules, not a semantic zero-contamination proof)');
  save();
}
