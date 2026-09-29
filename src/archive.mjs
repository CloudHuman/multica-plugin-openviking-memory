import { cap, slugify, shortHash } from './util.mjs';

/**
 * Pure builders: turn multica events + transcripts into OpenViking session
 * messages (parts mode), plus the archiving hygiene rules from the spec:
 *   - user business input preserved verbatim (issue text / comment / append);
 *   - agent visible replies, tool calls and results preserved as evidence;
 *   - system prompts, runtime briefs and thinking are NOT sedimented as user
 *     input (thinking opt-in as distillation nourishment only);
 *   - probe/high-frequency tool calls dropped by prefix;
 *   - sizes capped; nothing silently re-quoted as human speech.
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
  // The brief is a prefix block: drop from the marker to the end of its section.
  return text.slice(0, idx).trimEnd();
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

/**
 * Map one multica task transcript into OV messages.
 * transcript messages: {seq, type: thinking|tool_use|tool_result|text, tool, call_id, content, input, output}
 */
export function buildRunMessages({ taskId, agentId, issue, transcript = [], status = 'completed', cfg }) {
  const messages = [];
  const identifier = issue?.identifier ?? issue?.id ?? '';
  const title = issue?.title ?? '';
  const description = typeof issue?.description === 'string' ? issue.description : '';
  const turn = sanitizeSessionId(taskId);

  messages.push({
    role: 'user',
    message_kind: 'user_query',
    turn_id: turn,
    content: `[Multica 任务] ${identifier} ${title}\n\n任务描述：\n${description || '(无描述)'}\n\n执行智能体: ${agentId ?? 'unknown'} | 最终状态: ${status}`,
  });

  const drop = makeDropToolMatcher(cfg.dropToolPrefixes);
  const ordered = [...transcript].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  // A dropped tool_use drags its tool_result down with it (matched by call_id):
  // the command text lives in the call, not in the output.
  const droppedCalls = new Set(
    ordered.filter((m) => m.type === 'tool_use' && drop(m.tool, m.input)).map((m) => m.call_id).filter(Boolean),
  );
  let dropped = 0;
  for (const m of ordered) {
    switch (m.type) {
      case 'thinking':
        if (!cfg.includeThinking) continue;
        messages.push({
          role: 'assistant',
          message_kind: 'assistant_step',
          turn_id: turn,
          content: `[thinking] ${cap(m.content, cfg.textPartMaxChars)}`,
        });
        break;
      case 'text': {
        const clean = stripRuntimeBrief(m.content);
        if (!clean || !clean.trim()) break;
        messages.push({
          role: 'assistant',
          message_kind: 'assistant_step',
          turn_id: turn,
          parts: [{ type: 'text', text: cap(clean, cfg.textPartMaxChars) }],
        });
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
            tool_input: m.input ?? {},
            tool_status: 'completed',
          }],
        });
        break;
      }
      case 'tool_result': {
        if (droppedCalls.has(m.call_id) || drop(m.tool, m.output)) { dropped++; continue; }
        messages.push({
          role: 'user',
          message_kind: 'tool_transport',
          turn_id: turn,
          parts: [{
            type: 'tool',
            tool_id: m.call_id ?? `call-${m.seq}`,
            tool_name: m.tool ?? 'unknown',
            tool_output: cap(m.output, cfg.toolOutputMaxChars),
            tool_status: 'completed',
          }],
        });
        break;
      }
      default:
        break;
    }
  }
  return { messages, dropped, sessionId: `mc-task-${sanitizeSessionId(taskId)}` };
}

/** Comment → one attributed user message (peer_id = commenting member). */
export function buildCommentMessages({ comment, issue }) {
  const authorId = comment?.author?.id ?? comment?.author_id ?? 'unknown-member';
  const identifier = issue?.identifier ?? issue?.id ?? '';
  return {
    sessionId: `mc-comment-${sanitizeSessionId(comment.id ?? shortHash(JSON.stringify(comment)))}`,
    messages: [
      {
        role: 'user',
        message_kind: 'user_query',
        turn_id: `comment-${sanitizeSessionId(comment.id ?? 'x')}`,
        peer_id: authorId,
        content: `[人类反馈][评论] ${identifier} ${issue?.title ?? ''}\n\n${cap(comment.content, 8000)}\n\n作者: ${comment?.author?.name ?? authorId} | 时间: ${comment?.created_at ?? ''}`,
      },
    ],
  };
}

/** Companion: direct-chat transcript → pair-space messages. */
export function buildChatMessages({ chatRef, agentId, userId, messages = [] }) {
  const sid = `mc-chat-${sanitizeSessionId(chatRef)}`;
  const mapped = messages.map((m, i) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    message_kind: m.role === 'assistant' ? 'assistant_step' : 'user_query',
    turn_id: `${sid}-${m.turn ?? i}`,
    peer_id: m.role === 'assistant' ? undefined : String(userId),
    content: cap(typeof m.content === 'string' ? m.content : JSON.stringify(m.content), 4000),
  }));
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

/** Companion: delegation handoff content → channel-space record. */
export function buildDelegationMessages({ handoffId, fromAgentId, toAgentId, content }) {
  return {
    sessionId: `mc-deleg-${sanitizeSessionId(handoffId)}`,
    messages: [
      {
        role: 'user',
        message_kind: 'user_query',
        turn_id: `deleg-${sanitizeSessionId(handoffId)}`,
        peer_id: String(fromAgentId),
        content: `[委派交接] ${fromAgentId} → ${toAgentId}\n\n${cap(content, 8000)}`,
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

export function commitTags({ workspaceId, scopeKey, kind, refId }) {
  const tags = [
    `source=multica-plugin`,
    `workspace=${workspaceId}`,
    `scope=${scopeKey.split(':')[0]}`,
  ];
  if (kind) tags.push(`record=${kind}`);
  if (refId) tags.push(`ref=${String(refId).slice(0, 64)}`);
  return tags;
}

export function chunkMessages(messages, size = 100) {
  const chunks = [];
  for (let i = 0; i < messages.length; i += size) chunks.push(messages.slice(i, i + size));
  return chunks;
}
