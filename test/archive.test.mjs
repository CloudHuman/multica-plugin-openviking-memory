import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRunMessages, buildCommentMessages, buildChatMessages, buildAppendMessages,
  buildDelegationMessages, buildRememberFile, stripRuntimeBrief, makeDropToolMatcher,
  chunkMessages, commitTags,
} from '../src/archive.mjs';
import { fixtureIssue, fixtureTranscript, FIXTURE_ISSUE_ID, FIXTURE_WS, FIXTURE_AGENT_A, FIXTURE_USER } from './helpers.mjs';

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

test('comment builder attributes the author via peer_id', () => {
  const { sessionId, messages } = buildCommentMessages({
    comment: { id: 'c1', content: '死信队列部分再补充一下', author: { id: FIXTURE_USER, name: 'cloud' }, created_at: '2026-09-29T00:00:00Z' },
    issue: fixtureIssue(),
  });
  assert.equal(sessionId, 'mc-comment-c1');
  assert.equal(messages[0].peer_id, FIXTURE_USER);
  assert.match(messages[0].content, /死信队列部分再补充一下/);
  assert.match(messages[0].content, /人类反馈/);
});

test('chat / append / delegation builders', () => {
  const chat = buildChatMessages({
    chatRef: 'chat-9', agentId: 'a1', userId: 'u1',
    messages: [
      { role: 'user', content: '以后代码都用中文注释' },
      { role: 'assistant', content: '好的,已记住这个约定。' },
    ],
  });
  assert.equal(chat.sessionId, 'mc-chat-chat-9');
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
  assert.equal(commitTags({ workspaceId: FIXTURE_WS, scopeKey: `task:${FIXTURE_WS}:x` }).includes('agent='), false);
});
