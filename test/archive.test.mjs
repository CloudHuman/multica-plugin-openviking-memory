import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRunMessages, buildCommentMessages, buildChatMessages, buildAppendMessages,
  buildDelegationMessages, buildRememberFile, stripRuntimeBrief, makeDropToolMatcher,
  chunkMessages, commitTags, sanitizeTagValue,
} from '../src/archive.mjs';
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
  assert.match(member.messages[0].content, /^\[人类反馈\]\[评论\] MUL-7/);
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
