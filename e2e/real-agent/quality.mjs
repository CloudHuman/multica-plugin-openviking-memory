import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { listMemoryFiles } from '../../src/memory-inventory.mjs';
import { auditMemories } from './memory-audit.mjs';

// Real daemon + actual agent tools. No hand-authored assistant transcript and
// no active writes: the facts below must survive automatic native distillation.
export async function runQuality(ctx) {
  const { mc, ov, user, ws, agent: a, agentTemplate, pluginState, pluginUrl, pluginToken, report, step, save, wait, state, privateFile, toolResultData, canary } = ctx;
  const list = value => Array.isArray(value) ? value : value?.tasks ?? value?.messages ?? value?.comments ?? [];
  const call = (path, body, method = body === undefined ? 'GET' : 'POST') => mc.must(path, mc.call(path, { token: user.token, ws, method, body }));
  const scopes = () => JSON.parse(readFileSync(join(pluginState, 'scopes.json'), 'utf8')).scopes;
  const statuses = () => existsSync(join(pluginState, 'archives.jsonl')) ? readFileSync(join(pluginState, 'archives.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  const tasks = async agent => list(await call(`/api/agents/${agent.id}/tasks?include_usage=true`));
  const b = ctx.resume
    ? await call(`/api/agents/${report.agents.find(a => a.role === 'B').id}`, { runtime_id: agentTemplate.runtime_id }, 'PUT')
    : await call('/api/agents', { ...agentTemplate, name: `Quality reviewer ${ctx.run}` });
  report.agents = [{ id: a.id, role: 'A' }, { id: b.id, role: 'B' }];
  report.tasks ??= []; report.qualitySnapshots ??= []; save();
  async function completed(agent, match, entry) {
    let lastStatus;
    const task = await wait(entry, async () => {
      const t = (await tasks(agent)).find(match);
      if (t && lastStatus !== t.status) { lastStatus = t.status; console.log(`${entry}: ${t.status}`); }
      return t && ['completed', 'failed', 'cancelled'].includes(t.status) ? t : null;
    }, 360000);
    const messages = list(await call(`/api/tasks/${task.id}/messages?limit=2000`));
    const comments = task.issue_id ? list(await call(`/api/issues/${task.issue_id}/comments`)).filter(c => c.source_task_id === task.id && c.author_type === 'agent') : [];
    const chatReplies = task.chat_session_id ? list(await call(`/api/chat/sessions/${task.chat_session_id}/messages`)).filter(m => m.task_id === task.id && m.role === 'assistant') : [];
    const recalls = messages.filter(m => m.type === 'tool_result' && /memory.*recall/.test(m.tool ?? '')).map(toolResultData).filter(r => r?.status === 'ok').map(r => r.result);
    const response = [task.result?.output ?? '', ...comments.map(c => c.content), ...chatReplies.map(m => m.content), ...messages.filter(m => m.type === 'text').map(m => m.content)].join('\n');
    const record = { entry, taskId: task.id, agentId: agent.id, issueId: task.issue_id ?? null, chatSessionId: task.chat_session_id ?? null, status: task.status, error: task.error, response, recalls, comments, chatReplies, tools: messages.filter(m => m.type === 'tool_use').map(m => m.tool), startedAt: task.started_at, completedAt: task.completed_at };
    privateFile(join(state, `${entry}-${task.id}-transcript.json`), messages);
    report.tasks.push(record); save();
    if (task.status !== 'completed') throw new Error(`${entry}: ${task.status}: ${String(task.error ?? '').slice(0, 500)}`);
    return record;
  }
  async function issueRun(agent, title, description, entry) {
    const issue = await mc.createIssue(user.token, ws, { title, description });
    await mc.assign(user.token, ws, issue.id, agent.id);
    return { issue, record: await completed(agent, t => t.issue_id === issue.id, entry) };
  }
  async function chatRun(agent, title, content, entry) {
    const session = await call('/api/chat/sessions', { agent_id: agent.id, title });
    const sent = await call(`/api/chat/sessions/${session.id}/messages`, { content });
    return completed(agent, t => t.id === sent.task_id, entry);
  }
  async function extracted(ref) {
    return wait(`extract ${ref}`, async () => {
      const records = statuses().filter(e => e.type === 'extraction' && e.ref === ref);
      const latest = records.at(-1);
      if (latest && ['failed', 'timeout'].includes(latest.extraction)) throw new Error(`extraction ${ref}: ${latest.extraction}`);
      return latest?.extraction === 'done' ? latest : null;
    }, 300000);
  }
  async function snapshot(scope, label) {
    const rec = scopes()[scope];
    const inventory = await listMemoryFiles({ ov, key: rec.apiKey, userId: rec.userId });
    if (!inventory.complete) throw new Error(`Incomplete snapshot ${label}`);
    const files = [];
    for (const f of inventory.files) files.push({ uri: f.uri, content: (await ov.readContent(rec.apiKey, f.uri)).content });
    report.qualitySnapshots.push({ label, scope, files }); save();
    return files;
  }
  async function promote() {
    const response = await fetch(`${pluginUrl}/admin/consolidate`, { method: 'POST', headers: { Authorization: `Bearer ${pluginToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id: ws }) });
    const result = (await response.json()).result;
    if (!response.ok || !result?.session_id) throw new Error('Shared promotion was not admitted');
    report.promotions ??= []; report.promotions.push(result); save();
    await extracted(result.session_id);
    return result;
  }
  async function searchable(scope, query, pattern) {
    const rec = scopes()[scope];
    if (!rec) throw new Error(`Missing readiness scope ${scope}`);
    report.searchReadiness ??= [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const hits = (await ov.search(rec.apiKey, { query, limit: 5, deadline: Date.now() + 25000 })).memories ?? [];
        const contents = await Promise.all(hits.filter(h => h.context_type === 'memory').map(h => ov.readContent(rec.apiKey, h.uri)));
        const ready = contents.some(c => pattern.test(c.content ?? ''));
        report.searchReadiness.push({ scope, query, attempt, ready, ts: new Date().toISOString() }); save();
        if (ready) return;
        console.log(`Readiness ${scope}: expected indexed facts not returned (attempt ${attempt})`);
      } catch (error) {
        report.searchReadiness.push({ scope, query, attempt, ready: false, status: error.status, error: error.message, ts: new Date().toISOString() }); save();
        console.log(`Readiness ${scope}: search unavailable (attempt ${attempt})`);
      }
    }
    throw new Error(`Readiness search unavailable after three bounded attempts: ${scope}`);
  }
  const finish = '请先调用 memory-recall，按实际证据回复。不要修改代码，不要主动记录记忆，不要创建 issue 或唤醒规则。按平台流程提交简短回复。';
  try {
    if (!ctx.resume) {
    const seed = await issueRun(a, '苍鹭蒸馏质量初始约定', `成员正式确认：苍鹭发布使用 Apache Pulsar；每月预算 7600 元；双写持续五天。以后这个项目的代码注释一律使用中文。${finish} 本次成员确认是直接证据，历史检索为空不影响确认。必须实际用 read 读取任务目录 AGENTS.md，但不要复述平台说明。`, 'quality-seed');
    const taskScope = `task:${ws}:${seed.issue.id}`;
    await extracted(seed.record.taskId);
    const before = await snapshot(taskScope, 'before-update');
    const beforeText = before.map(f => f.content).join('\n');
    step('automatic-fact-fidelity', /Pulsar/.test(beforeText) && /7600/.test(beforeText) && /五天|5\s*天/.test(beforeText), 'Real automatic extraction preserved all three supplied business facts');
    step('lasting-preference-retained', before.some(f => /\/preferences\//.test(f.uri) && /中文/.test(f.content)), 'Lasting Chinese-comment preference survived alongside temporary task controls');
    step('no-active-write-shortcut', !seed.record.tools.some(t => /memory.*remember|ov.*write/.test(t)), 'Seed used automatic extraction, not active memory writes');
    await promote();
    const previousIds = new Set((await tasks(a)).map(t => t.id));
    await mc.comment(user.token, ws, seed.issue.id, `新的正式要求：苍鹭发布预算调整为 8100 元，其他约定不变，明确以本次更新为准。${finish}`);
    const update = await completed(a, t => t.issue_id === seed.issue.id && !previousIds.has(t.id), 'quality-budget-update');
    await extracted(update.taskId);
    // Comments have their own extraction and must settle before inspecting the
    // mutable entity card; the run's completion alone isn't that barrier.
    await wait('all source extractions', async () => {
      const pending = JSON.parse(readFileSync(join(pluginState, 'extractions.json'), 'utf8')).pending;
      return Object.keys(pending ?? {}).length === 0;
    }, 300000);
    const after = await snapshot(taskScope, 'after-update');
    const cards = after.filter(f => /\/entities\//.test(f.uri) && /苍鹭/.test(f.content));
    step('current-entity-update', cards.some(f => hasCurrentBudget(f.content)), 'Current entity uses 8100, marks any 7600 mention as historical, and preserves queue and double-write duration');
    step('historical-budget-retained', after.some(f => /\/events\//.test(f.uri) && /7600/.test(f.content)), 'Historical 7600 decision remains traceable as an event');
    step('entity-category-stable', new Set(cards.map(f => f.uri)).size === 1 && before.some(f => f.uri === cards[0]?.uri), 'Same subject retained one stable entity URI across the update');
    const updatedPromotion = await promote();
    step('updated-uri-repromoted', updatedPromotion.promoted.some(p => before.some(f => f.uri.endsWith(`/${p.file}`) && /\/entities\//.test(f.uri))), 'An updated existing entity was admitted to shared promotion');
    } else {
      const after = report.qualitySnapshots.find(s => s.label === 'after-update');
      if (!after) throw new Error('Quality continuation requires the original update snapshot');
      report.validatorCorrections ??= [];
      report.validatorCorrections.push({ check: 'current-entity-update', reason: 'Old check rejected any 7600 mention; stored card explicitly marks it as previous, with current budget 8100. Corrected check rejects unresolved old current values while accepting labelled history.' });
      step('current-entity-update', after.files.some(f => /\/entities\//.test(f.uri) && hasCurrentBudget(f.content)), 'Original stored entity has current 8100 and explicitly labelled previous 7600, preserving all other facts');
    }
    await searchable(`shared:${ws}`, '苍鹭发布当前消息系统、月预算与双写周期', /8100/);
    let answer = ctx.resume ? [...report.tasks].reverse().find(t => t.entry === 'quality-shared-recall' && hasSharedRecall(t, `shared:${ws}`)) : null;
    if (answer) {
      // A model error after posting the correct comment does not invalidate
      // the observed tool recall. Keep its failed delivery as a separate check.
      report.deliveryLimitations ??= [];
      if (answer.status !== 'completed') report.deliveryLimitations.push({ taskId: answer.taskId, status: answer.status, error: answer.error });
    } else if (ctx.resume) {
      const failed = report.tasks.find(t => t.entry === 'quality-shared-recall' && t.status === 'failed');
      if (!failed) throw new Error('Quality continuation requires the original failed B query');
      const original = await call(`/api/issues/${failed.issueId}`);
      // An issue rerun can resume an existing runtime session and merely echo
      // its prior answer. A fresh task tests actual new tool calls and recall.
      const description = original.description ?? original.issue?.description;
      if (typeof description !== 'string' || !description.includes('苍鹭')) throw new Error('Original answer-withheld question is unavailable');
      answer = (await issueRun(b, '苍鹭新任务复核当前约定', description, 'quality-shared-recall')).record;
    } else {
      answer = (await issueRun(b, '另一智能体查询苍鹭最新业务约定', `苍鹭发布目前的消息系统、每月预算和双写周期分别是什么？${finish} 本次没有提供答案数值；只依据实际 memory-recall 来源回答，不要查询其他 issue。回复中引用来源 URI。`, 'quality-shared-recall')).record;
    }
    step('real-B-current-shared-recall', hasSharedRecall(answer, `shared:${ws}`), 'Actual B recovered all current facts from shared memory without supplied answer values');
    step('real-B-task-delivery', answer.status === 'completed', 'Task completion is checked separately from recalled facts and persisted comments');
    await extracted(answer.taskId);
    const dm = report.tasks.find(t => t.entry === 'quality-dm-seed' && t.status === 'completed')
      ?? await chatRun(a, '蓝鹊持久周报格式', `蓝鹊周报是我的私人排版约定：今后固定按“风险、进展、下一步”三个中文标题，风险放第一。仅用于私聊，不写入公共记忆。${finish}`, 'quality-dm-seed');
    await extracted(dm.taskId);
    const dmScope = `dm:${ws}:${a.id}:${user.userId}`;
    const dmFiles = await snapshot(dmScope, 'private-preference');
    step('dm-distilled-peer-layout', dmFiles.some(f => /\/peers\//.test(f.uri) && /\/preferences\//.test(f.uri) && /风险、进展、下一步/.test(f.content)), 'Real private layout was extracted into the peer memory namespace');
    await searchable(dmScope, '蓝鹊周报之前约定的三个标题和顺序', /风险、进展、下一步/);
    const recalled = report.tasks.find(t => t.entry === 'quality-dm-recall' && t.status === 'completed' && t.recalls?.some(r => r.entries?.some(e => e.scope === dmScope)))
      ?? await chatRun(a, '蓝鹊新会话查询', `蓝鹊周报之前约定的三个标题及顺序是什么？${finish} 本次没有再次提供标题；根据实际召回回复并引用来源 URI。`, 'quality-dm-recall');
    step('real-DM-layout-recall', /风险/.test(recalled.response) && /进展/.test(recalled.response) && /下一步/.test(recalled.response) && recalled.recalls.some(r => r.entries.some(e => e.scope === dmScope && recalled.response.includes(e.uri))), 'New actual chat recovered private layout from its pair memory');
    await extracted(recalled.taskId);
    const audit = await auditMemories({ ov, scopes: scopes(), canary });
    report.memoryAudit = audit;
    step('peer-audit-coverage', audit.every(s => s.complete) && audit.some(s => s.scope === dmScope && s.peerFiles > 0), 'Complete memory audit included peer-owned private memories');
    step('reusable-memory-hygiene', audit.every(s => !s.qualityFindings.length), 'Known run controls, retrieval outcomes and platform scaffolding absent from reusable memories');
    step('runtime-markers-filtered', audit.every(s => !s.containsPlatformCanary && !s.containsRuntimeBanner && !s.containsPlatformGuidance), 'Known injected runtime markers absent from extracted memories');
    save();
  } finally {
    const remaining = (await tasks(a)).concat(await tasks(b)).filter(t => !['completed', 'failed', 'cancelled'].includes(t.status));
    for (const task of remaining) await call(`/api/tasks/${task.id}/cancel`, {});
    report.cleanup = { cancelledTasks: remaining.map(t => t.id) }; save();
  }
}

// 7600 must read as superseded: a marker shortly before it, or "已被取代" style wording after it.
const HISTORY_BEFORE_7600 = /(?:此前|原先|原预算|历史|取代|替代|较早|早先|previous|historical|supersed|replac|earlier|former).{0,20}7600/i;
const HISTORY_AFTER_7600 = /7600.{0,20}(?:已?被(?:取代|替代)|superseded|replaced)/i;

export function hasCurrentBudget(content) {
  const current = /^\s*-.*(?:预算|budget).{0,25}8100\s*元/im.test(content);
  const oldMentions = String(content).split('\n').filter(line => /7600/.test(line));
  return current && oldMentions.every(line => HISTORY_BEFORE_7600.test(line) || HISTORY_AFTER_7600.test(line))
    && /Pulsar/.test(content) && /五天|5\s*天/.test(content);
}

export function hasSharedRecall(record, scope) {
  return /8100/.test(record.response) && /Pulsar/.test(record.response) && /五天|5\s*天/.test(record.response)
    && record.recalls?.some(r => r.run?.bound && r.entries?.some(e => e.scope === scope && record.response.includes(e.uri)));
}
