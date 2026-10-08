import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRunMessages, buildCommentMessages, buildChatMessages, buildAppendMessages,
  buildDelegationMessages, buildRememberFile, stripRuntimeBrief, makeDropToolMatcher,
  chunkMessages, commitTags, sanitizeTagValue,
} from '../src/archive.mjs';
import { archiveSettings, loadConfig } from '../src/config.mjs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureIssue, fixtureTranscript, FIXTURE_ISSUE_ID, FIXTURE_WS, FIXTURE_AGENT_A, FIXTURE_AGENT_B, FIXTURE_USER } from './helpers.mjs';

const cfg = {
  includeThinking: false,
  textPartMaxChars: 4000,
  toolOutputMaxChars: 8000,
  dropToolPrefixes: ['multica issue list'],
};

test('run archive maps transcript to OV parts-mode messages', () => {
  const taskId = 'task-1';
  const t = fixtureTranscript({ taskId });
  const { messages, sessionId, dropped } = buildRunMessages({
    taskId, agentId: FIXTURE_AGENT_A, issue: fixtureIssue(), transcript: t, status: 'completed', cfg,
  });
  assert.equal(sessionId, 'mc-task-task-1');
  // user_query + 1 text + tool_use + tool_result (+runtime text dropped as empty) + final text
  const kinds = messages.map((m) => `${m.role}/${m.message_kind}`);
  assert.deepEqual(kinds, [
    'user/user_query',
    'assistant/assistant_step',       // 先看一下…
    'assistant/assistant_step',       // web_search tool_use (parts)
    'user/tool_transport',            // web_search tool_result
    'assistant/assistant_step',       // 结论…
  ]);
  assert.equal(dropped, 2); // multica issue list pair dropped

  const first = messages[0];
  assert.match(first.content, /为消息推送服务选型并给出迁移方案/);
  assert.match(first.content, /对比 Kafka 与 RocketMQ/);
  assert.match(first.content, new RegExp(FIXTURE_AGENT_A));
  assert.equal(first.turn_id, 'task-1');

  const toolUse = messages[2];
  assert.equal(toolUse.parts[0].type, 'tool');
  assert.equal(toolUse.parts[0].tool_name, 'web_search');
  assert.equal(toolUse.parts[0].tool_status, 'completed');

  const toolRes = messages[3];
  assert.equal(toolRes.parts[0].tool_output.includes('partition-level ordering'), true);
  assert.equal(toolRes.parts[0].tool_id, 'call-1');

  const final = messages[4];
  assert.match(final.parts[0].text, /推荐 RocketMQ/);
  // thinking was excluded (spec: 内部思考不作为用户原话沉淀)
  assert.equal(messages.some((m) => /thinking/.test(m.content ?? '')), false);
});

test('runtime brief block is stripped from text parts', () => {
  assert.equal(stripRuntimeBrief('# Multica Agent Runtime\n你是智能体\n---\n业务内容'), '');
  assert.equal(stripRuntimeBrief('业务 A\n# Multica Agent Runtime\n简报'), '业务 A');
  assert.equal(stripRuntimeBrief('普通文本'), '普通文本');
});

test('runtime instructions read by tools never enter distillation, while member input stays intact', () => {
  const brief = '# Multica Agent Runtime\nPLATFORM_ONLY_CANARY\nUse the multica CLI.';
  const human = `Review this literal heading: ${brief}`;
  const { messages } = buildRunMessages({
    taskId: 'tool-runtime', agentId: 'a', issue: fixtureIssue(),
    task: { input: [{ author_type: 'member', author_id: 'u', content: human }] },
    transcript: [
      { seq: 1, type: 'tool_use', tool: 'bash', call_id: 'c', input: { command: `cat <<'EOF'\n${brief}`, nested: [{ text: brief }] } },
      { seq: 2, type: 'tool_result', tool: 'read', call_id: 'r', output: `<content>\n1: ${brief}\n</content>` },
      { seq: 3, type: 'tool_result', tool: 'bash', call_id: 'c', output: { business: 'Budget: 3800', instructions: [brief] } },
      { seq: 4, type: 'error', content: `Business failure\n${brief}` },
      { seq: 5, type: 'thinking', content: `Business reasoning\n${brief}` },
    ], cfg: { ...cfg, includeThinking: true },
  });
  const businessInput = messages.find(m => m.content?.includes(human));
  assert.ok(businessInput, 'human business input must remain verbatim');
  const evidence = messages.filter(m => m !== businessInput);
  const raw = JSON.stringify(evidence);
  assert.doesNotMatch(raw, /PLATFORM_ONLY_CANARY|# Multica Agent Runtime|Use the multica CLI/);
  assert.match(raw, /Budget: 3800/);
  assert.match(raw, /Business failure/);
  assert.match(raw, /Business reasoning/);
});

test('an agent record listed by a tool is archived without the agent\'s instructions', () => {
  // The real 10-08 shape: quick-create looked itself up with `multica agent list --output json`.
  const listed = JSON.stringify([{ id: 'a1', name: 'Real memory auditor', description: 'Authorized isolated real-agent memory test', instructions: '使用中文完成任务。内部运行标记 PLATFORM_ONLY_CANARY 只用于平台测试，"不是"业务事实。', status: 'idle' }], null, 2);
  const { messages } = buildRunMessages({
    taskId: 'agent-record', agentId: 'a1', issue: fixtureIssue(),
    transcript: [
      { seq: 1, type: 'tool_use', tool: 'bash', call_id: 'c', input: { command: 'multica agent list --output json' } },
      { seq: 2, type: 'tool_result', tool: 'bash', call_id: 'c', output: listed },
      { seq: 3, type: 'tool_result', tool: 'bash', call_id: 'd', output: { agent: { name: 'Reviewer', instructions: 'PLATFORM_ONLY_CANARY' } } },
      { seq: 4, type: 'tool_result', tool: 'bash', call_id: 'e', output: `${listed.slice(0, listed.indexOf('PLATFORM_ONLY'))}PLATFORM_ONLY_CAN` },
    ], cfg,
  });
  const outputs = messages.filter(m => m.message_kind === 'tool_transport').map(m => m.parts[0].tool_output);
  assert.equal(outputs.length, 3);
  for (const output of outputs) {
    assert.doesNotMatch(output, /PLATFORM_ONLY|使用中文完成任务/);
    assert.match(output, /"instructions"\s*:\s*"\[智能体指令已省略\]"/);
  }
  assert.match(outputs[0], /"name": "Real memory auditor"/, 'the rest of the record stays');
  assert.match(outputs[0], /"status": "idle"/);
  assert.match(outputs[1], /"name":"Reviewer"/);
});

test('agent comments and chat replies filter runtime instructions without changing member messages', () => {
  const brief = '# Multica Agent Runtime\nPLATFORM_ONLY_CANARY';
  const agentComment = buildCommentMessages({ comment: { id: 'c', author_type: 'agent', content: `Budget: 3800\n${brief}` }, issue: fixtureIssue() });
  assert.match(JSON.stringify(agentComment.messages), /Budget: 3800/);
  assert.doesNotMatch(JSON.stringify(agentComment.messages), /PLATFORM_ONLY_CANARY/);
  const runtimeOnly = buildCommentMessages({ comment: { id: 'c2', author_type: 'agent', content: brief }, issue: fixtureIssue() });
  assert.equal(runtimeOnly.messages.length, 0);
  const chat = buildChatMessages({ chatRef: 'chat', userId: 'u', messages: [{ role: 'user', content: brief }, { role: 'assistant', content: `Confirmed\n${brief}` }, { role: 'assistant', content: brief }] });
  assert.equal(chat.messages.length, 2);
  assert.equal(chat.messages[0].content, brief);
  assert.equal(chat.messages[1].content, 'Confirmed');
});

test('members\' words are archived without their one-run controls by default; off keeps them verbatim', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'ovmem-cfg-'));
  assert.equal(loadConfig({}, { stateDir }).archiveDropRunControls, true, 'on by default');
  assert.equal(loadConfig({ OVMEM_ARCHIVE_DROP_RUN_CONTROLS: '0' }, { stateDir }).archiveDropRunControls, false);
  assert.equal(loadConfig({ OVMEM_ARCHIVE_DROP_RUN_CONTROLS: 'false' }, { stateDir }).archiveDropRunControls, false);
  assert.equal(loadConfig({ OVMEM_ARCHIVE_DROP_RUN_CONTROLS: '1' }, { stateDir }).archiveDropRunControls, true);
  assert.equal(archiveSettings(loadConfig({}, { stateDir })).archiveDropRunControls, true, 'queued jobs keep the setting');
  // The fixed instructions a member appended in the 2026-10-08 real runs.
  const finish = '请先调用 memory-recall，按实际证据回复。不要修改代码，不要主动记录记忆，不要创建 issue 或唤醒规则。按平台流程提交简短回复。';
  const description = `成员正式确认：苍鹭发布使用 Apache Pulsar；每月预算 7600 元。以后这个项目的代码注释一律使用中文。${finish}`;
  const issue = { ...fixtureIssue(), description };
  const chatInput = { source: 'chat_message', author_type: 'member', author_id: FIXTURE_USER, content: `蓝鹊周报固定按“风险、进展、下一步”排版。${finish}` };
  const agentInput = { source: 'handoff', author_type: 'agent', author_id: FIXTURE_AGENT_B, content: `交接：请复核预算。${finish}` };
  const run = (on, kind = 'issue', input = [agentInput]) => buildRunMessages({
    taskId: `strip-${on}-${kind}`, agentId: FIXTURE_AGENT_A, kind, issue, cfg: { ...cfg, archiveDropRunControls: on },
    task: { id: 't', kind, chat_user_id: FIXTURE_USER, input }, transcript: [{ seq: 1, type: 'text', content: '已确认。' }],
  }).messages;
  assert.match(run(false)[0].content, /不要修改代码/, 'off: archived as written');
  const [task, handoff] = run(true);
  assert.doesNotMatch(task.content, /请先调用 memory-recall|按平台流程提交简短回复/);
  assert.match(task.content, /Apache Pulsar；每月预算 7600 元/);
  assert.match(task.content, /以后这个项目的代码注释一律使用中文/, 'a stated lasting policy stays');
  assert.match(handoff.content, /交接：请复核预算。请先调用 memory-recall/, 'only members\' words change');
  const [chat] = run(true, 'chat', [chatInput]);
  assert.match(chat.content, /蓝鹊周报固定按/);
  assert.doesNotMatch(chat.content, /不要修改代码/);

  const comment = (content, on) => buildCommentMessages({ comment: { id: 'c', author_type: 'member', author_id: FIXTURE_USER, content }, issue, cfg: { archiveDropRunControls: on } }).messages;
  assert.match(comment(`预算调整为 8100 元。${finish}`, false)[0].content, /按平台流程/);
  assert.doesNotMatch(comment(`预算调整为 8100 元。${finish}`, true)[0].content, /按平台流程|memory-recall/);
  assert.deepEqual(comment(finish, true), [], 'nothing but run controls: nothing to archive');
  const pairChat = buildChatMessages({ chatRef: 'chat', userId: FIXTURE_USER, cfg: { archiveDropRunControls: true }, messages: [{ role: 'user', content: finish }, { role: 'user', content: '' }, { role: 'assistant', content: '好的' }] });
  assert.deepEqual(pairChat.messages.map((m) => m.content), ['', '好的'], 'an emptied turn is dropped; an empty one is kept as before');
  assert.doesNotMatch(buildAppendMessages({ appendId: 'a', taskId: 't', content: `顺便给出回滚方案。${finish}`, cfg: { archiveDropRunControls: true } }).messages[0].content, /memory-recall/);
});

test('include_thinking opt-in keeps thinking as distillation nourishment', () => {
  const t = fixtureTranscript({ taskId: 't2' });
  const { messages } = buildRunMessages({
    taskId: 't2', agentId: 'a', issue: fixtureIssue(), transcript: t, status: 'completed',
    cfg: { ...cfg, includeThinking: true },
  });
  assert.equal(messages.some((m) => /^\[thinking\]/.test(m.content ?? '')), true);
});

test('long outputs and texts are capped', () => {
  const long = 'x'.repeat(20_000);
  const { messages } = buildRunMessages({
    taskId: 't3', agentId: 'a', issue: fixtureIssue(),
    transcript: [
      { seq: 1, type: 'text', content: long },
      { seq: 2, type: 'tool_result', tool: 'sh', call_id: 'c1', output: long },
    ],
    status: 'completed', cfg,
  });
  assert.ok(messages[1].parts[0].text.length < 5000);
  assert.ok(messages[2].parts[0].tool_output.length < 9000);
  assert.match(messages[2].parts[0].tool_output, /truncated/);
});

test('comment builder: members are human feedback, agents speak as assistants, plugins as neither', () => {
  const issue = fixtureIssue();
  const base = { created_at: '2026-09-29T00:00:00Z', type: 'comment', issue_id: FIXTURE_ISSUE_ID };

  const member = buildCommentMessages({ comment: { ...base, id: 'c1', author_type: 'member', author_id: FIXTURE_USER, content: '死信队列部分再补充一下' }, issue });
  assert.equal(member.sessionId, 'mc-comment-c1');
  assert.equal(member.messages.length, 1);
  assert.equal(member.messages[0].role, 'user');
  assert.equal(member.messages[0].peer_id, FIXTURE_USER);
  assert.match(member.messages[0].content, /^\[人类反馈\]\[评论\] 「为消息推送服务选型并给出迁移方案」/);
  assert.match(member.messages[0].content, /死信队列部分再补充一下/);

  const agent = buildCommentMessages({ comment: { ...base, id: 'c2', author_type: 'agent', author_id: FIXTURE_AGENT_A, content: '已完成压测,结论见附件。' }, issue });
  assert.deepEqual(agent.messages.map((m) => m.role), ['user', 'assistant']);
  assert.match(agent.messages[0].content, /^\[任务上下文\]/);
  assert.equal(agent.messages[0].peer_id, undefined, 'the context line is not attributed to a person');
  assert.match(agent.messages[1].parts[0].text, /^\[智能体评论\] 智能体 33333333/);
  assert.match(agent.messages[1].parts[0].text, /已完成压测/);

  const plugin = buildCommentMessages({ comment: { ...base, id: 'c3', author_type: 'plugin', author_id: 'inst-1', content: 'CI 通过' }, issue });
  assert.equal(plugin.messages.length, 1);
  assert.match(plugin.messages[0].content, /^\[插件消息\]/);
  assert.equal(plugin.messages[0].peer_id, undefined);
  assert.equal(/人类反馈/.test(plugin.messages[0].content), false);
  // Archived text names the issue by its title; its key would be copied into memory cards.
  for (const archived of [member, agent, plugin]) assert.equal(JSON.stringify(archived.messages).includes('MUL-7'), false);
  const untitled = buildCommentMessages({ comment: { ...base, id: 'c4', author_type: 'member', author_id: FIXTURE_USER, content: '补充' }, issue: { ...issue, title: '' } });
  assert.match(untitled.messages[0].content, /^\[人类反馈\]\[评论\] MUL-7/);
});

test('run builder is kind-aware and archives the input that started the run', () => {
  const taskId = 'chat-run-1';
  const chat = buildRunMessages({
    taskId, agentId: FIXTURE_AGENT_A, kind: 'chat', status: 'completed', cfg,
    task: {
      id: taskId, kind: 'chat', chat_user_id: FIXTURE_USER,
      input: [{ source: 'chat_message', author_type: 'member', author_id: FIXTURE_USER, content: '帮我把周报改成要点形式' }],
    },
    transcript: [{ seq: 1, type: 'text', content: '好的,已改为要点。' }],
  });
  // No anonymous context line: every user-role message is the member's own words.
  assert.deepEqual(chat.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(chat.messages[0].peer_id, FIXTURE_USER);
  assert.match(chat.messages[0].content, /^\[私聊消息\] 成员 55555555[^\n]*（与智能体 33333333[^\n]* 的私聊）:\n帮我把周报改成要点形式/);
  assert.equal(chat.evidence, 1);
  const chatWithoutInput = buildRunMessages({ taskId, agentId: FIXTURE_AGENT_A, kind: 'chat', cfg, task: { id: taskId, kind: 'chat', chat_user_id: FIXTURE_USER, input: [] }, transcript: [] });
  assert.match(chatWithoutInput.messages[0].content, /^\[私聊\] 成员 55555555/, 'without the member\'s words, the context line stays');

  const autopilot = buildRunMessages({
    taskId: 'ap-run', agentId: FIXTURE_AGENT_A, kind: 'autopilot', cfg,
    task: { id: 'ap-run', kind: 'autopilot', autopilot_id: 'ap-1', trigger_summary: '每日 09:00', input: [] },
    transcript: [],
  });
  assert.match(autopilot.messages[0].content, /^\[自动化运行\] autopilot ap-1\n触发: 每日 09:00/);
  assert.equal(autopilot.evidence, 0, 'a run with no transcript has no evidence to archive');

  const fromComment = buildRunMessages({
    taskId: 'issue-run', agentId: FIXTURE_AGENT_A, kind: 'issue', issue: fixtureIssue(), cfg,
    task: { id: 'issue-run', kind: 'issue', input: [{ source: 'comment', author_type: 'agent', author_id: FIXTURE_AGENT_B, content: '@A 请补充回滚方案' }] },
    transcript: [],
  });
  assert.match(fromComment.messages[1].content, /^\[触发评论\] 智能体 44444444/);
  assert.equal(fromComment.messages[1].peer_id, undefined, 'one owner per run archive; the label carries attribution');
});

test('tool inputs are always objects, and run errors are archived as evidence', () => {
  const { messages, evidence } = buildRunMessages({
    taskId: 't-err', agentId: 'a', issue: fixtureIssue(), cfg, status: 'failed',
    transcript: [
      { seq: 1, type: 'tool_use', tool: 'sh', call_id: 'c1', input: 'ls -la' },
      { seq: 2, type: 'tool_use', tool: 'sh', call_id: 'c2', input: ['git', 'status'] },
      { seq: 3, type: 'tool_use', tool: 'sh', call_id: 'c3' },
      { seq: 4, type: 'error', content: 'agent exited: context window exceeded' },
    ],
  });
  const inputs = messages.filter((m) => m.parts?.[0]?.type === 'tool').map((m) => m.parts[0].tool_input);
  assert.deepEqual(inputs, [{ value: 'ls -la' }, { value: ['git', 'status'] }, {}]);
  assert.match(messages.at(-1).parts[0].text, /^\[运行错误\] agent exited/);
  assert.match(messages[0].content, /最终状态: failed/);
  assert.equal(evidence, 4);
});

test('chat / append / delegation builders', () => {
  const chat = buildChatMessages({
    chatRef: 'chat-9', turnKey: 'turn-3', agentId: 'a1', userId: 'u1',
    messages: [
      { role: 'user', content: '以后代码都用中文注释' },
      { role: 'assistant', content: '好的,已记住这个约定。' },
    ],
  });
  assert.equal(chat.sessionId, 'mc-chat-chat-9-turn-3', 'one session per turn');
  assert.equal(chat.messages[0].peer_id, 'u1');
  assert.equal(chat.messages[1].message_kind, 'assistant_step');

  const app = buildAppendMessages({ appendId: 'ap1', taskId: 'run-7', content: '顺便给出回滚方案' });
  assert.match(app.messages[0].content, /已确认投递/);
  assert.match(app.messages[0].content, /顺便给出回滚方案/);

  const del = buildDelegationMessages({ handoffId: 'h1', fromAgentId: 'a1', toAgentId: 'a2', content: '请复核选型结论' });
  assert.equal(del.messages[0].peer_id, 'a1');
  assert.match(del.messages[0].content, /委派交接/);
});

test('delegation inputs filter agent runtime briefs while member input stays verbatim', () => {
  const brief = '# Multica Agent Runtime\nPLATFORM_ONLY_HANDOFF';
  const content = `业务重试上限为七次。\n${brief}`;
  const run = buildRunMessages({ taskId: 'delegation-brief', agentId: 'b', kind: 'issue', cfg,
    task: { input: [
      { source: 'comment', author_type: 'agent', author_id: 'a', content },
      { source: 'comment', author_type: 'member', author_id: 'u', content },
    ] }, transcript: [] });
  assert.match(run.messages[1].content, /业务重试上限为七次/);
  assert.ok(!run.messages[1].content.includes('PLATFORM_ONLY_HANDOFF'));
  assert.ok(run.messages[2].content.includes(content));
  const handoff = buildDelegationMessages({ handoffId: 'handoff-brief', fromAgentId: 'a', toAgentId: 'b', content });
  assert.match(handoff.messages[0].content, /业务重试上限为七次/);
  assert.ok(!handoff.messages[0].content.includes('PLATFORM_ONLY_HANDOFF'));
});

test('remember file builds frontmattered memory in agent-public namespace', () => {
  const f = buildRememberFile({ title: 'RocketMQ 选型结论', content: '顺序性场景选 RocketMQ,预算内。', kind: 'cases', agentId: FIXTURE_AGENT_A });
  assert.match(f.uri, /^memories\/cases\/\d{4}-\d{2}-\d{2}\/[\w\u4e00-\u9fff-]+-[0-9a-f]{6}\.md$/);
  assert.match(f.content, /origin: multica-agent-active/);
  assert.match(f.content, /author_agent: /);
  assert.match(f.content, /RocketMQ 选型结论/);
  // unknown kind falls back to experiences
  const f2 = buildRememberFile({ title: 't', content: 'c', kind: 'weird', agentId: 'a' });
  assert.match(f2.uri, /^memories\/experiences\//);
});

test('drop matcher, chunking and commit tags', () => {
  const drop = makeDropToolMatcher(['multica issue list', 'web_search']);
  assert.equal(drop('multica', ['issue', 'list']), true); // command via array input
  assert.equal(drop('multica', { cmd: ['issue', 'list'] }), true); // object input
  assert.equal(drop('multica issue list'), true);
  assert.equal(drop('multica', ['issue', 'get', 'MUL-1']), false);
  assert.equal(drop('web_search', '{}'), true);
  assert.equal(makeDropToolMatcher([])('anything'), false);

  const chunks = chunkMessages(Array.from({ length: 250 }, (_, i) => ({ i })), 100);
  assert.deepEqual(chunks.map((c) => c.length), [100, 100, 50]);

  const tags = commitTags({ workspaceId: FIXTURE_WS, scopeKey: `task:${FIXTURE_WS}:${FIXTURE_ISSUE_ID}`, kind: 'archive-run', refId: 'task-1', agentId: FIXTURE_AGENT_A });
  assert.ok(tags.includes('source=multica-plugin'));
  assert.ok(tags.includes('scope=task'));
  assert.ok(tags.includes('workspace=' + FIXTURE_WS));
  assert.ok(tags.includes('agent=' + FIXTURE_AGENT_A));
  assert.equal(commitTags({ workspaceId: FIXTURE_WS, scopeKey: `task:${FIXTURE_WS}:x` }).some((t) => t.startsWith('agent=')), false);
});

test('commit tags stay strict k=v whatever the ids contain (OV rejects anything else)', () => {
  const tags = commitTags({ workspaceId: 'ws=1, evil', scopeKey: 'task:x:y', kind: 'archive run', refId: 'a=b=c', agentId: '' });
  for (const t of tags) {
    const parts = t.split('=');
    assert.equal(parts.length, 2, t);
    assert.ok(parts[0] && parts[1], t);
  }
  assert.equal(sanitizeTagValue(''), 'none');
  assert.ok(sanitizeTagValue('x'.repeat(200)).length <= 64);
});
