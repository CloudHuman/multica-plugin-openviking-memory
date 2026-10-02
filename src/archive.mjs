import { cap, slugify, shortHash } from './util.mjs';

/**
 * Pure builders: turn multica events + transcripts into OpenViking session
 * messages (parts mode), plus the archiving hygiene rules from the spec:
 *   - user business input preserved verbatim (issue text / chat message / comment);
 *   - agent visible replies, tool calls and results preserved as evidence;
 *   - who said what is kept honest: a member's words are user input attributed
 *     to that member (peer_id), an agent's words are assistant output, and a
 *     plugin's or system's text is never presented as a person's;
 *   - system prompts, runtime briefs and thinking are NOT sedimented as user
 *     input (thinking opt-in as distillation nourishment only);
 *   - probe/high-frequency tool calls dropped by prefix;
 *   - sizes capped.
 */

export const RUNTIME_BRIEF_MARK = '# Multica Agent Runtime';

export function sanitizeSessionId(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Strip an injected runtime-brief section from an agent text part. */
export function stripRuntimeBrief(text, marker = RUNTIME_BRIEF_MARK) {
  if (typeof text !== 'string') return text;
  const idx = text.indexOf(marker);
  if (idx === -1) return text;
  // Everything from the marker on is dropped: the brief has no reliable end
  // marker, and leaking part of it is worse than losing a trailing sentence.
  return text.slice(0, idx).trimEnd();
}

/** Preserve nested payload shape while removing recognized runtime briefs. */
function stripRuntimeBriefValue(value) {
  if (typeof value === 'string') return stripRuntimeBrief(value);
  if (Array.isArray(value)) return value.map(stripRuntimeBriefValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stripRuntimeBriefValue(item)]));
  }
  return value;
}

/** Flatten a tool input (string / array / object) into comparable command text. */
export function toolInputToText(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) return input.map(toolInputToText).join(' ');
  if (typeof input === 'object') {
    try {
      return Object.values(input).map(toolInputToText).join(' ');
    } catch {
      return '';
    }
  }
  return String(input);
}

export function makeDropToolMatcher(prefixes) {
  const list = (prefixes ?? []).map((p) => String(p).trim()).filter(Boolean);
  if (!list.length) return () => false;
  return (toolName, input) => {
    const name = String(toolName ?? '');
    const probe = `${name} ${toolInputToText(input)}`.replace(/\s+/g, ' ').trim();
    return list.some((p) => name === p || name.startsWith(p) || probe.startsWith(p));
  };
}

/** OV requires tool_input to be an object; transcripts may carry anything. */
function toolInputObject(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input;
  if (input == null || input === '') return {};
  return { value: input };
}

const HEADER = {
  issue: '[Multica 任务]',
  chat: '[私聊]',
  autopilot: '[自动化运行]',
  quick_create: '[快速创建]',
  other: '[运行]',
};

/**
 * How archived text names an issue: by its title. The issue key (MUL-7) is
 * workspace bookkeeping that extraction copies into memory cards, so it is
 * used only for an issue without a title.
 */
function issueName(issue) {
  const title = String(issue?.title ?? '').trim();
  return title ? `「${title}」` : String(issue?.identifier ?? '').trim();
}

/** The human/agent input that started a run, as attributed user messages. */
function inputMessages(inputs, turn, cfg, { chatWith } = {}) {
  const out = [];
  for (const item of inputs ?? []) {
    const raw = String(item?.content ?? '').trim();
    const text = item?.author_type === 'agent' ? stripRuntimeBrief(raw) : raw;
    if (!text) continue;
    let who = item.author_type === 'agent' ? `智能体 ${item.author_id}` : item.author_type === 'member' ? `成员 ${item.author_id}` : (item.author_type || '未知来源');
    if (chatWith && item.source === 'chat_message') who += `（与智能体 ${chatWith} 的私聊）`;
    const label = {
      chat_message: '[私聊消息]',
      comment: '[触发评论]',
      quick_create: '[快速创建请求]',
      handoff: '[委派交接]',
    }[item.source] ?? '[输入]';
    const msg = {
      role: 'user',
      message_kind: 'user_query',
      turn_id: turn,
      content: `${label} ${who}:\n${cap(text, cfg.textPartMaxChars)}`,
    };
    // peer_id only where that person is the one human voice (a chat). In other
    // runs the label carries attribution: OV derives an event's owner from the
    // messages it cites, and a second owner (the member beside the space's own
    // user) makes ownership ambiguous, so the event is dropped or filed twice.
    // The trigger comment and a handoff are archived with their peer_id on
    // their own (comment.created, archive-delegation).
    if (chatWith && item.author_type === 'member' && item.author_id) msg.peer_id = String(item.author_id);
    out.push(msg);
  }
  return out;
}

/**
 * Map one multica run (task + transcript) into OV messages.
 * run: { taskId, agentId, kind, status, issue?, task? (GET /v1/tasks payload) }
 * transcript: [{seq, type: text|tool_use|tool_result|error|thinking, tool, call_id, content, input, output}]
 */
export function buildRunMessages({ taskId, agentId, kind = 'issue', issue, task, transcript = [], status = 'completed', cfg }) {
  const messages = [];
  const turn = sanitizeSessionId(taskId);
  const header = HEADER[kind] ?? HEADER.other;
  let context;
  if (kind === 'issue') {
    const description = typeof issue?.description === 'string' ? issue.description : '';
    context = `${[header, issueName(issue)].filter(Boolean).join(' ')}\n\n任务描述：\n${cap(description, cfg.textPartMaxChars) || '(无描述)'}`;
  } else if (kind === 'chat') {
    context = `${header} 成员 ${task?.chat_user_id ?? 'unknown'} 与智能体 ${agentId} 的对话`;
  } else if (kind === 'autopilot') {
    context = `${header} autopilot ${task?.autopilot_id ?? ''}${task?.trigger_summary ? `\n触发: ${task.trigger_summary}` : ''}`;
  } else {
    context = `${header}${task?.trigger_summary ? ` ${task.trigger_summary}` : ''}`;
  }
  // In a chat every user-role line must be the member's own words: OV attributes
  // a user message without peer_id to an anonymous "user", which in a DM space
  // produced a second, unattributed copy of the member's preferences. So a chat
  // run carries its context inside the member's labelled messages instead.
  const input = inputMessages(task?.input, turn, cfg, kind === 'chat' ? { chatWith: agentId ?? 'unknown' } : {});
  const chatInputOnly = kind === 'chat' && input.some((m) => m.peer_id);
  if (!chatInputOnly) {
    messages.push({
      role: 'user',
      message_kind: 'user_query',
      turn_id: turn,
      content: `${context}\n\n执行智能体: ${agentId ?? 'unknown'} | 最终状态: ${status}`,
    });
  }
  messages.push(...input);

  const drop = makeDropToolMatcher(cfg.dropToolPrefixes);
  const ordered = [...transcript].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  // A dropped tool_use drags its tool_result down with it (matched by call_id):
  // the command text lives in the call, not in the output.
  const droppedCalls = new Set(
    ordered.filter((m) => m.type === 'tool_use' && drop(m.tool, m.input)).map((m) => m.call_id).filter(Boolean),
  );
  let dropped = 0;
  let evidence = 0;
  for (const m of ordered) {
    switch (m.type) {
      case 'thinking': {
        if (!cfg.includeThinking) continue;
        const clean = stripRuntimeBrief(m.content);
        if (!clean || !clean.trim()) break;
        messages.push({
          role: 'assistant',
          message_kind: 'assistant_step',
          turn_id: turn,
          content: `[thinking] ${cap(clean, cfg.textPartMaxChars)}`,
        });
        break;
      }
      case 'text': {
        const clean = stripRuntimeBrief(m.content);
        if (!clean || !clean.trim()) break;
        messages.push({
          role: 'assistant',
          message_kind: 'assistant_step',
          turn_id: turn,
          parts: [{ type: 'text', text: cap(clean, cfg.textPartMaxChars) }],
        });
        evidence++;
        break;
      }
      case 'error': {
        const text = stripRuntimeBrief(String(m.content ?? m.output ?? '')).trim();
        if (!text) break;
        messages.push({
          role: 'assistant',
          message_kind: 'assistant_step',
          turn_id: turn,
          parts: [{ type: 'text', text: `[运行错误] ${cap(text, cfg.textPartMaxChars)}` }],
        });
        evidence++;
        break;
      }
      case 'tool_use': {
        if (droppedCalls.has(m.call_id) || drop(m.tool, m.input)) { dropped++; continue; }
        messages.push({
          role: 'assistant',
          message_kind: 'assistant_step',
          turn_id: turn,
          parts: [{
            type: 'tool',
            tool_id: m.call_id ?? `call-${m.seq}`,
            tool_name: m.tool ?? 'unknown',
            tool_input: toolInputObject(stripRuntimeBriefValue(m.input)),
            tool_status: 'completed',
          }],
        });
        evidence++;
        break;
      }
      case 'tool_result': {
        if (droppedCalls.has(m.call_id) || drop(m.tool, m.output)) { dropped++; continue; }
        const clean = stripRuntimeBriefValue(m.output);
        const output = clean && typeof clean === 'object' ? JSON.stringify(clean) : clean;
        messages.push({
          role: 'user',
          message_kind: 'tool_transport',
          turn_id: turn,
          parts: [{
            type: 'tool',
            tool_id: m.call_id ?? `call-${m.seq}`,
            tool_name: m.tool ?? 'unknown',
            tool_output: cap(output, cfg.toolOutputMaxChars),
            tool_status: 'completed',
          }],
        });
        evidence++;
        break;
      }
      default:
        break;
    }
  }
  return { messages, dropped, evidence, sessionId: `mc-task-${sanitizeSessionId(taskId)}` };
}

/**
 * Comment → attributed record. A member's comment is human feedback (user
 * role, peer_id = that member); an agent's comment is that agent's statement
 * (assistant role, after a one-line context turn so extraction has a user-role
 * anchor); a plugin's is labelled as such and attributed to no person.
 */
export function buildCommentMessages({ comment, issue }) {
  const authorType = comment?.author_type ?? 'member';
  const authorId = String(comment?.author_id ?? comment?.author?.id ?? '');
  const where = issueName(issue);
  const turn = `comment-${sanitizeSessionId(comment.id ?? 'x')}`;
  const rawBody = String(comment.content ?? '');
  const body = cap(authorType === 'agent' ? stripRuntimeBrief(rawBody) : rawBody, 8000);
  const when = comment?.created_at ?? '';
  const sessionId = `mc-comment-${sanitizeSessionId(comment.id ?? shortHash(JSON.stringify(comment)))}`;
  if (authorType === 'agent') {
    if (!body.trim()) return { sessionId, messages: [] };
    return {
      sessionId,
      messages: [
        { role: 'user', message_kind: 'user_query', turn_id: turn, content: `[任务上下文] ${where}` },
        {
          role: 'assistant',
          message_kind: 'assistant_step',
          turn_id: turn,
          parts: [{ type: 'text', text: `[智能体评论] 智能体 ${authorId} 在 ${where || '该任务'} 下发表 (${when}):\n\n${body}` }],
        },
      ],
    };
  }
  if (authorType === 'plugin') {
    return {
      sessionId,
      messages: [{ role: 'user', message_kind: 'user_query', turn_id: turn, content: `[插件消息] ${where}\n\n${body}\n\n来源插件: ${authorId} | 时间: ${when}` }],
    };
  }
  const msg = {
    role: 'user',
    message_kind: 'user_query',
    turn_id: turn,
    content: `[人类反馈][评论] ${where}\n\n${body}\n\n作者: 成员 ${authorId || 'unknown'} | 时间: ${when}`,
  };
  if (authorId) msg.peer_id = authorId;
  return { sessionId, messages: [msg] };
}

/** Companion: one direct-chat turn → pair-space messages (one session per turn). */
export function buildChatMessages({ chatRef, turnKey, agentId, userId, messages = [] }) {
  const sid = `mc-chat-${sanitizeSessionId(chatRef)}${turnKey ? `-${sanitizeSessionId(turnKey)}` : ''}`;
  const mapped = messages.flatMap((m, i) => {
    const isAgent = m.role === 'assistant';
    const clean = isAgent ? stripRuntimeBriefValue(m.content) : m.content;
    const text = typeof clean === 'string' ? clean : JSON.stringify(clean);
    if (isAgent && !String(text ?? '').trim()) return [];
    const out = {
      role: isAgent ? 'assistant' : 'user',
      message_kind: isAgent ? 'assistant_step' : 'user_query',
      turn_id: `${sid}-${m.turn ?? i}`,
      content: cap(text, 4000),
    };
    if (!isAgent && userId) out.peer_id = String(userId);
    return out;
  });
  return { sessionId: sid, messages: mapped };
}

/** Companion: mid-run appended requirement → confirmed-delivery record. */
export function buildAppendMessages({ appendId, taskId, content, delivered = true }) {
  return {
    sessionId: `mc-append-${sanitizeSessionId(appendId)}`,
    messages: [
      {
        role: 'user',
        message_kind: 'user_query',
        turn_id: `append-${sanitizeSessionId(appendId)}`,
        content: `[当前轮追加][${delivered ? '已确认投递' : '投递未确认'}] 目标运行 ${taskId}\n\n${cap(content, 8000)}`,
      },
    ],
  };
}

/** Delegation handoff content → channel-space record. */
export function buildDelegationMessages({ handoffId, fromAgentId, toAgentId, content }) {
  return {
    sessionId: `mc-deleg-${sanitizeSessionId(handoffId)}`,
    messages: [
      {
        role: 'user',
        message_kind: 'user_query',
        turn_id: `deleg-${sanitizeSessionId(handoffId)}`,
        peer_id: String(fromAgentId),
        content: `[委派交接] ${fromAgentId} → ${toAgentId}\n\n${cap(stripRuntimeBrief(content), 8000)}`,
      },
    ],
  };
}

/** Agent-curated active write → markdown memory file body. */
export function buildRememberFile({ title, content, kind = 'experiences', agentId, now = new Date() }) {
  const k = ['experiences', 'cases', 'entities', 'preferences', 'events'].includes(kind) ? kind : 'experiences';
  const heading = String(title ?? '').trim() || String(content).trim().split('\n')[0].slice(0, 60) || 'agent memory';
  const front = [
    '---',
    `title: ${heading.replace(/\n/g, ' ')}`,
    `created_at: ${now.toISOString()}`,
    `author_agent: ${agentId}`,
    'origin: multica-agent-active',
    `kind: ${k}`,
    '---',
    '',
  ].join('\n');
  return {
    uri: `memories/${k}/${now.toISOString().slice(0, 10)}/${slugify(heading)}-${shortHash(content, 6)}.md`,
    content: `${front}${String(content).trim()}\n`,
  };
}

/**
 * OV accepts strict `key=value` search tags only: exactly one '=', both sides
 * non-empty. Values come from client-supplied ids, so anything else is folded.
 */
export function sanitizeTagValue(value) {
  return String(value ?? '')
    .replace(/[=\s,]+/g, '_')
    .replace(/[^\p{L}\p{N}._:\-_/]+/gu, '_')
    .slice(0, 64) || 'none';
}

/**
 * Commit tags. OV attaches them as searchable scalar tags to the EVENT memories
 * a commit produces (e.g. filter by agent=); they are not shown to the extractor,
 * whose attribution comes from the message text and peer_id.
 */
export function commitTags({ workspaceId, scopeKey, kind, refId, agentId }) {
  const tags = [
    `source=multica-plugin`,
    `workspace=${sanitizeTagValue(workspaceId)}`,
    `scope=${sanitizeTagValue(scopeKey.split(':')[0])}`,
  ];
  if (kind) tags.push(`record=${sanitizeTagValue(kind)}`);
  if (refId) tags.push(`ref=${sanitizeTagValue(refId)}`);
  if (agentId) tags.push(`agent=${sanitizeTagValue(agentId)}`);
  return tags;
}

export function chunkMessages(messages, size = 100) {
  const chunks = [];
  for (let i = 0; i < messages.length; i += size) chunks.push(messages.slice(i, i + size));
  return chunks;
}
