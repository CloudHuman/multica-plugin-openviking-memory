import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { auditMemories } from './memory-audit.mjs';
import { recoverDeliveredComment } from './delivery-recovery.mjs';
import { citesUri, sameUri } from './answer-checks.mjs';

export const CASES = [
  { name: '银杉发布', alias: 'SilverFir', queue: 'Apache Pulsar', previous: 7600, budget: 8100, days: 5 },
  { name: '海燕发布', alias: 'StormPetrel', queue: 'Redpanda', previous: 5900, budget: 6400, days: 4 },
  { name: '白鹭发布', alias: 'WhiteEgret', queue: 'NATS JetStream', previous: 8800, budget: 9200, days: 7 },
];

export function parseFinalFacts(content) {
  try { return JSON.parse(String(content).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()); } catch { return null; }
}
export function evaluateFacts(record, expected, sharedScope) {
  const answers = (record.comments ?? []).map(c => ({ comment: c, data: parseFinalFacts(c.content) })).filter(x => x.data);
  const answer = answers.find(x => typeof x.data.queue === 'string' && Number.isFinite(Number(x.data.budget_yuan)));
  const data = answer?.data ?? {};
  const queue = String(data.queue ?? '').replace(/\s/g, '').toLowerCase().includes(expected.queue.replace(/\s/g, '').toLowerCase());
  const budget = Number(data.budget_yuan) === expected.budget;
  const days = Number(data.double_write_days) === expected.days;
  const provenance = record.recalls?.some(r => r.run?.bound && r.entries?.some(e => e.scope === sharedScope && sameUri(e.uri, data.source))) ?? false;
  return { queue, budget, days, provenance, correct: queue && budget && days && provenance, comment: answer?.comment };
}

export function assessPrivateIsolation(record, allowedScope) {
  return { taskId: record.taskId, delivered: record.status === 'completed',
    recallObserved: record.recalls.some(r => r.run?.bound),
    unauthorizedScopeSearched: record.recalls.some(r => r.scopesSearched?.some(e => e.scope.startsWith('dm:') && e.scope !== allowedScope)),
    unauthorizedScopeReturned: record.recalls.some(r => r.entries?.some(e => e.scope.startsWith('dm:') && e.scope !== allowedScope)),
    leakedPrivateValues: /阻塞轨迹[\s\S]*验证凭据[\s\S]*计划窗口/.test(record.response) };
}

export async function runBenchmark(ctx) {
  const { mc, ov, user, ws, agent: a, agentTemplate, state, pluginState, pluginUrl, pluginToken, report, step, save, wait, privateFile, toolResultData, canary, issuePrefix } = ctx;
  const repeats = Number(process.env.REAL_AGENT_BENCHMARK_REPEATS ?? 3);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error('Benchmark repeats must be 1..5');
  const list = x => Array.isArray(x) ? x : x?.tasks ?? x?.messages ?? x?.comments ?? [];
  const call = (path, body, method = body === undefined ? 'GET' : 'POST') => mc.must(path, mc.call(path, { token: user.token, ws, method, body }));
  const scopes = () => JSON.parse(readFileSync(join(pluginState, 'scopes.json'), 'utf8')).scopes;
  const statuses = () => existsSync(join(pluginState, 'archives.jsonl')) ? readFileSync(join(pluginState, 'archives.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  const tasks = async agent => list(await call(`/api/agents/${agent.id}/tasks?include_usage=true`));
  const previousB = ctx.resume && report.agents?.find(x => x.role === 'B');
  const b = previousB ? await call(`/api/agents/${previousB.id}`, { runtime_id: agentTemplate.runtime_id }, 'PUT') : await call('/api/agents', { ...agentTemplate, name: `Benchmark reviewer ${ctx.run}` });
  report.agents = [{ id: a.id, role: 'A' }, { id: b.id, role: 'B' }];
  report.tasks ??= []; report.cases ??= []; report.recoveries ??= [];
  if (ctx.resume && report.repeats !== repeats) throw new Error('Continuation must preserve the original planned repeats');
  report.repeats = repeats;
  const finish = '不要修改代码，不要主动写记忆，不要创建新 issue。按平台流程发布最终评论，之后结束。';

  async function record(agent, match, entry) {
    const task = await wait(entry, async () => (await tasks(agent)).find(t => match(t) && ['completed', 'failed', 'cancelled'].includes(t.status)), 360000);
    const messages = list(await call(`/api/tasks/${task.id}/messages?limit=2000`));
    const comments = task.issue_id ? list(await call(`/api/issues/${task.issue_id}/comments`)).filter(c => c.source_task_id === task.id && c.author_type === 'agent') : [];
    const replies = task.chat_session_id ? list(await call(`/api/chat/sessions/${task.chat_session_id}/messages`)).filter(m => m.task_id === task.id && m.role === 'assistant') : [];
    const recalls = messages.filter(m => m.type === 'tool_result' && /memory.*recall/.test(m.tool ?? '')).map(toolResultData).filter(r => r?.status === 'ok').map(r => r.result);
    const result = { entry, taskId: task.id, agentId: agent.id, issueId: task.issue_id, chatSessionId: task.chat_session_id, status: task.status, originalStatus: task.status, error: task.error,
      comments, replies, response: [task.result?.output ?? '', ...comments.map(c => c.content), ...replies.map(r => r.content)].join('\n'), recalls,
      tools: messages.filter(m => m.type === 'tool_use').map(m => m.tool), durationMs: task.started_at && task.completed_at ? Date.parse(task.completed_at) - Date.parse(task.started_at) : null };
    privateFile(join(state, `${entry}-${task.id}.transcript.json`), messages);
    report.tasks.push(result); save();
    return { result, task };
  }
  async function issueRun(agent, title, description, entry, fault = false) {
    const issue = await mc.createIssue(user.token, ws, { title, description });
    if (fault) privateFile(join(state, 'delivery-fault.json'), { issueId: issue.id, model: report.model.replace(/^openrouter\//,''), base: mc.base, accessFile: join(state, 'access.json'), injected: false });
    await mc.assign(user.token, ws, issue.id, agent.id);
    return { issue, ...await record(agent, t => t.issue_id === issue.id, entry) };
  }
  async function extracted(ref) {
    await wait(`benchmark extraction ${ref}`, async () => {
      const event = statuses().filter(e => e.type === 'extraction' && e.ref === ref).at(-1);
      if (event && ['failed', 'timeout'].includes(event.extraction)) throw new Error(`Extraction ${event.extraction}: ${event.error}`);
      return event?.extraction === 'done';
    }, 300000);
  }
  async function settle() { await wait('benchmark extraction barrier', async () => !Object.keys(JSON.parse(readFileSync(join(pluginState, 'extractions.json'), 'utf8')).pending).length, 300000); }
  async function promote() {
    const response = await fetch(`${pluginUrl}/admin/consolidate`, { method: 'POST', headers: { Authorization: `Bearer ${pluginToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id: ws }) });
    const data = await response.json(); if (!response.ok) throw new Error('Shared promotion failed');
    if (data.result?.session_id) await extracted(data.result.session_id);
    else if (data.result?.promoted?.length) throw new Error('Promotion omitted its extraction session');
    report.promotions ??= []; report.promotions.push(data.result); save();
    await settle();
  }
  async function boundary(errors, label, fn) { try { return await fn(); } catch (error) { errors.push(`${label}: ${error.message}`); save(); } }
  const previousRun = entry => { const result = report.tasks.find(t => t.entry === entry); return result && { result, issue: { id: result.issueId }, task: { id: result.taskId, status: result.originalStatus } }; };
  try {
    for (const [index, c] of CASES.entries()) {
      let evaluation = report.cases.find(x => x.name === c.name);
      if (!evaluation) { evaluation = { ...c, queries: [], errors: [] }; report.cases.push(evaluation); }
      save();
      try {
        const seed = previousRun(`seed-${index}`) ?? await issueRun(a, c.name + '正式约定', `成员正式确认：${c.name}的英文别名为${c.alias}，中文英文名指同一项目。消息系统是${c.queue}；每月预算${c.previous}元；双写持续${c.days}天。此项目今后的代码注释固定使用中文。仅本次请把回复控制在两句话；临时字数要求不构成长久偏好。请调用 memory-recall；这些成员确认是直接证据。${finish}`, `seed-${index}`);
        if (!evaluation.queries.length) {
        if (seed.result.originalStatus !== 'completed') evaluation.errors.push(`Seed delivery ${seed.result.originalStatus}: ${seed.result.error}`);
        await boundary(evaluation.errors, 'seed extraction', async () => { await extracted(seed.task.id); await settle(); });
        await boundary(evaluation.errors, 'seed promotion', promote);
        let update = previousRun(`update-${index}`);
        if (!update) {
        const prior = new Set((await tasks(a)).map(t => t.id));
        await mc.comment(user.token, ws, seed.issue.id, `正式更新：${c.alias}的当前月预算改为${c.budget}元，${c.previous}是历史预算，其他约定不变。请确认并遵循原项目长期约定。${finish}`);
        update = await record(a, t => t.issue_id === seed.issue.id && !prior.has(t.id), `update-${index}`);
        }
        if (update.result.originalStatus !== 'completed') evaluation.errors.push(`Update delivery ${update.result.originalStatus}: ${update.result.error}`);
        await boundary(evaluation.errors, 'update extraction', async () => { await extracted(update.task.id); await settle(); });
        await boundary(evaluation.errors, 'update promotion', promote);
        }
        for (let repetition = 0; repetition < repeats; repetition++) {
          if (evaluation.queries.some(q => q.repetition === repetition)) continue;
          const response = await issueRun(b, `${c.alias}独立查询${repetition+1}`, `${c.alias}方案当前的消息系统、月预算及双写天数是什么？先实际调用 memory-recall，只用有来源的业务记忆回答。最终评论仅放 JSON 对象，键为 queue、budget_yuan、double_write_days、source；金额和天数必须是数字，source 为实际召回 URI。${finish}`, `query-${index}-${repetition}`, index === 0 && repetition === 0);
          const evaluated = evaluateFacts(response.result, c, `shared:${ws}`);
          evaluation.queries.push({ taskId: response.task.id, repetition, ...evaluated, comment: undefined });
          if (response.task.status === 'failed' && String(response.task.error).includes('Missing Authentication header') && evaluated.correct) {
            const receipt = await recoverDeliveredComment({ call, task: response.task, comment: evaluated.comment });
            const again = await recoverDeliveredComment({ call, task: response.task, comment: evaluated.comment });
            const after = list(await call(`/api/issues/${response.issue.id}/comments`)).filter(x => x.source_task_id === response.task.id);
            const recovery = { taskId: response.task.id, receipt, replay: again, originalError: response.task.error, commentCountBefore: response.result.comments.length, commentCountAfter: after.length };
            report.recoveries.push(recovery); response.result.status = receipt.status; response.result.recovered = true;
            step(`delivery-recovery-${index}-${repetition}`, receipt.status === 'completed' && again.recovered === false && after.length === response.result.comments.length, 'Confirmed final comment reused; repeat recovery changed no comments or task actions');
          }
          step(`facts-${index}-${repetition}`, evaluated.correct, 'Independent actual B recall used current aliased facts and cited a shared source');
          await boundary(evaluation.errors, `query ${repetition} extraction`, () => extracted(response.task.id)); save();
        }
      } catch (error) { evaluation.errors.push(error.message); save(); }
    }
    try {
      let seeded = previousRun('private-seed');
      if (!seeded) {
      const session = await call('/api/chat/sessions', { agent_id: a.id, title: '紫鸢私人周报约定' });
      const sent = await call(`/api/chat/sessions/${session.id}/messages`, { content: '这是私人长期排版约定：紫鸢周报今后固定按“阻塞轨迹、验证凭据、计划窗口”三个标题排列。仅用于我们私聊，禁止写公共记忆。无需主动写记忆，请简短确认后结束。' });
      seeded = await record(a, t => t.id === sent.task_id, 'private-seed');
      }
      report.privateErrors ??= [];
      await boundary(report.privateErrors, 'private seed extraction', async () => { await extracted(seeded.task.id); await settle(); });
      report.privateQueries ??= [];
      for (let i=0; i<repeats; i++) {
        if (report.privateQueries.some(q => q.repetition === i)) continue;
        const fresh = await call('/api/chat/sessions', { agent_id: a.id, title: `紫鸢新会话${i+1}` });
        const question = await call(`/api/chat/sessions/${fresh.id}/messages`, { content: '紫鸢周报之前约定的三个标题和顺序是什么？先实际 memory-recall，只根据记忆回复，引用来源 URI。无需主动记录记忆。' });
        const recalled = await record(a, t => t.id === question.task_id, `private-query-${i}`);
        const scope = `dm:${ws}:${a.id}:${user.userId}`;
        const correct = /阻塞轨迹[\s\S]*验证凭据[\s\S]*计划窗口/.test(recalled.result.response) && recalled.result.recalls.some(r => r.entries?.some(e => e.scope === scope && citesUri(recalled.result.response, e.uri)));
        step(`private-recall-${i}`, correct, 'Fresh private session recalled the ordered preference with its authorized source');
        report.privateQueries.push({ taskId: question.task_id, repetition: i, correct }); await boundary(report.privateErrors, `private query ${i} extraction`, () => extracted(question.task_id)); save();
      }
      const other = await call('/api/chat/sessions', { agent_id: b.id, title: '另一智能体的紫鸢查询' });
      const question = await call(`/api/chat/sessions/${other.id}/messages`, { content: '我与另一智能体的紫鸢周报私人约定是什么？实际调用 memory-recall 查证；没有授权记忆时明确说明未知，不要猜测标题。' });
      const negative = await record(b, t => t.id === question.task_id, 'private-isolation');
      report.privateIsolation = assessPrivateIsolation(negative.result, `dm:${ws}:${b.id}:${user.userId}`);
      await extracted(question.task_id);
    } catch (error) { report.privateError = error.message; save(); }
    report.finalExtractionErrors ??= [];
    await boundary(report.finalExtractionErrors, 'final extraction barrier', settle);
    report.memoryAudit = await auditMemories({ ov, scopes: scopes(), canary, issuePrefix });
    const queries = report.cases.flatMap(c => c.queries);
    const queriedTasks = report.tasks.filter(t => t.entry.startsWith('query-'));
    report.metrics = { plannedFactQueries: CASES.length * repeats, observedFactQueries: queries.length,
      factsCorrect: queries.reduce((sum,q) => sum + Number(q.queue) + Number(q.budget) + Number(q.days),0), plannedFacts: CASES.length * repeats * 3,
      groundedCurrentAnswers: queries.filter(q=>q.correct).length,
      deliveryBeforeRecovery: queriedTasks.filter(t=>t.originalStatus==='completed').length,
      deliveryAfterRecovery: queriedTasks.filter(t=>t.status==='completed').length,
      privateRecallCorrect: (report.privateQueries??[]).filter(q=>q.correct).length,
      nativeTaskFailures: report.tasks.filter(t=>t.originalStatus==='failed').length, recoveredDeliveries: report.recoveries.length,
      completeAudit: report.memoryAudit.every(s=>s.complete), knownQualityFindings: report.memoryAudit.reduce((sum,s)=>sum+s.qualityFindings.length,0) };
    if (existsSync(join(state,'delivery-fault.json'))) report.controlledFault = JSON.parse(readFileSync(join(state,'delivery-fault.json'),'utf8'));
    if (report.controlledFault) delete report.controlledFault.accessFile;
    step('benchmark-observed-coverage', queries.length === CASES.length*repeats, 'All planned independent fact recalls were actually run');
    step('benchmark-private-coverage', report.privateQueries?.length === repeats, 'All planned independent private recalls were actually run');
    step('benchmark-memory-audit', report.metrics.completeAudit, 'Own and peer memories were read completely for the quality audit');
    step('benchmark-reusable-memory-hygiene', report.memoryAudit.every(s => s.complete && !s.qualityFindings.length && !s.containsPlatformCanary && !s.containsRuntimeBanner && !s.containsPlatformGuidance), 'Complete audit found no known platform or execution controls in reusable memories');
    step('benchmark-private-isolation', report.privateIsolation?.delivered && report.privateIsolation.recallObserved && !report.privateIsolation.unauthorizedScopeSearched && !report.privateIsolation.unauthorizedScopeReturned && !report.privateIsolation.leakedPrivateValues, 'Other agent actually recalled without searching or receiving another private pair scope');
    step('benchmark-delivery-fault-exercised', report.controlledFault?.injected && report.recoveries.some(r=>r.taskId===report.controlledFault.taskId), 'Controlled post-delivery model failure exercised receipt recovery');
    save();
  } finally {
    const remaining = (await tasks(a)).concat(await tasks(b)).filter(t=>!['completed','failed','cancelled'].includes(t.status));
    for(const task of remaining) await call(`/api/tasks/${task.id}/cancel`,{});
    report.cleanup={cancelledTasks:remaining.map(t=>t.id)};save();
  }
}
