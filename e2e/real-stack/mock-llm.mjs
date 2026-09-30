#!/usr/bin/env node
/**
 * Deterministic OpenAI-compatible stand-in for OpenViking's model providers.
 *
 *   POST /v1/embeddings        hashed char uni/bi-gram vectors (lexical-overlap similarity)
 *   POST /v1/chat/completions  - extraction calls (system prompt carries a JSON Schema):
 *                                returns a schema-shaped operations object that writes ONE
 *                                memory built from the conversation text
 *                              - everything else (abstract/overview summaries): short text
 *
 * Only model OUTPUTS are synthetic; every OpenViking code path stays real.
 * Env: MOCK_LLM_PORT (default 18999), MOCK_LLM_LOG (jsonl request log), MOCK_LLM_MODE
 *      ("write" default | "empty" returns empty operations | "fail" returns HTTP 429)
 */
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const PORT = Number(process.env.MOCK_LLM_PORT ?? 18999);
const LOG = process.env.MOCK_LLM_LOG ?? '';
let MODE = process.env.MOCK_LLM_MODE ?? 'write';

function log(rec) {
  if (!LOG) return;
  try { appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n'); } catch { /* best effort */ }
}

// ---------------------------------------------------------------- embeddings
function embed(text, dims) {
  const v = new Float32Array(dims);
  const s = String(text ?? '').toLowerCase();
  const chars = [...s].filter((c) => !/\s/.test(c));
  const grams = [];
  for (let i = 0; i < chars.length; i++) {
    grams.push(chars[i]);
    if (i + 1 < chars.length) grams.push(chars[i] + chars[i + 1]);
  }
  for (const g of grams) {
    const h = createHash('md5').update(g).digest();
    const idx = h.readUInt32LE(0) % dims;
    const sign = h[4] & 1 ? 1 : -1;
    v[idx] += sign * (g.length === 2 ? 1.5 : 1);
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) v[i] /= norm;
  if (norm === 1 && grams.length === 0) v[0] = 1; // empty input → unit vector
  return v;
}

// ---------------------------------------------------------------- chat helpers
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('\n');
  return '';
}

function extractSchema(system) {
  const m = system.match(/```json\n([\s\S]*?)\n```/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function resolveRef(root, node) {
  let n = node;
  let guard = 0;
  while (n && n.$ref && guard++ < 20) {
    const path = n.$ref.replace(/^#\//, '').split('/');
    n = path.reduce((acc, k) => acc?.[k], root);
  }
  if (n?.anyOf) {
    const nonNull = n.anyOf.find((x) => x.type !== 'null');
    return resolveRef(root, nonNull ?? n.anyOf[0]);
  }
  if (n?.allOf && n.allOf.length === 1) return resolveRef(root, n.allOf[0]);
  return n;
}

/** Build a value satisfying a (resolved) schema node, seeded with conversation text. */
function sample(root, node, ctx, depth = 0) {
  const n = resolveRef(root, node) ?? {};
  if (depth > 6) return null;
  if (n.enum) return n.enum[0];
  if (n.const !== undefined) return n.const;
  const type = Array.isArray(n.type) ? n.type.find((t) => t !== 'null') : n.type;
  switch (type) {
    case 'string': {
      const key = ctx.key ?? '';
      if (/uri/i.test(key)) return '';
      if (/name|title|topic|key|slug/i.test(key)) return ctx.title;
      return ctx.body;
    }
    case 'integer': {
      if (/page_id/i.test(ctx.key ?? '')) return 100;
      if (/start|begin|from/i.test(ctx.key ?? '')) return 0;
      if (/end|to/i.test(ctx.key ?? '')) return Math.max(0, ctx.lastIndex);
      return n.minimum ?? 0;
    }
    case 'number': return n.minimum ?? 0.9;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': {
      const out = {};
      const req = new Set(n.required ?? []);
      for (const [k, sub] of Object.entries(n.properties ?? {})) {
        if (!req.has(k) && !/page_id|content|summary|body|text|title|name|topic/i.test(k)) continue;
        out[k] = sample(root, sub, { ...ctx, key: k }, depth + 1);
      }
      return out;
    }
    default:
      return ctx.body;
  }
}

function conversationText(messages) {
  // OpenViking renders the archived conversation into one user message headed
  // "## Conversation History" as `[i][role][peer]: text` lines — use only that.
  const hist = messages.map((m) => textOf(m.content)).find((c) => c.includes('## Conversation History'));
  if (hist) {
    return hist
      .split('\n')
      .filter((l) => !/^(##|\*\*Session Time|Relative times)/.test(l.trim()))
      .map((l) => l.replace(/^\[\d+\](\[[^\]]*\])+:\s*/, ''))
      .join('\n');
  }
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => textOf(m.content))
    .join('\n');
}

function pickBusinessLine(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const scored = lines
    .filter((l) => !/^(#|```|\{|\}|\[|\]|<)/.test(l) && l.length > 12)
    .filter((l) => !/^(After exploring|Output|Return|Do not|You )/i.test(l))
    .map((l) => ({ l, s: (/(结论|推荐|约定|决定|记住|规范|阈值|要求|方案|MARKER)/.test(l) ? 1000 : 0) + (/[一-鿿]/.test(l) ? 300 : 0) + Math.min(l.length, 200) }));
  scored.sort((a, b) => b.s - a.s);
  return (scored[0]?.l ?? lines[0] ?? 'no content').slice(0, 600);
}

function buildOperations(schema, messages) {
  const text = conversationText(messages);
  const body = pickBusinessLine(text);
  const title = body.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 24) || 'memory';
  const lastIndex = Math.max(0, (text.match(/\[(\d+)\]/g) ?? []).length - 1);
  const props = schema?.properties ?? {};
  const ops = {};
  for (const k of Object.keys(props)) ops[k] = Array.isArray(resolveRef(schema, props[k])?.type === 'array' ? [] : null) ? [] : [];
  for (const k of Object.keys(props)) {
    const node = resolveRef(schema, props[k]);
    ops[k] = node?.type === 'array' ? [] : sample(schema, node, { key: k, body, title, lastIndex });
  }
  if (MODE === 'empty') return { ops, chosen: null };
  // Prefer a free-form, non-event memory type so no message-range resolution is needed.
  const prefs = ['entities', 'cases', 'preferences', 'experiences', 'tools', 'skills', 'events'];
  const arrays = Object.keys(props).filter((k) => resolveRef(schema, props[k])?.type === 'array' && !/delete|link/i.test(k));
  const chosen = prefs.find((p) => arrays.includes(p)) ?? arrays[0];
  if (chosen) {
    const itemSchema = resolveRef(schema, resolveRef(schema, props[chosen]).items);
    ops[chosen] = [sample(schema, itemSchema, { key: chosen, body, title, lastIndex })];
  }
  return { ops, chosen };
}

function chatCompletion(body) {
  const messages = body.messages ?? [];
  const system = textOf(messages.find((m) => m.role === 'system')?.content ?? '');
  const schema = extractSchema(system);
  let content;
  let kind;
  if (schema) {
    const { ops, chosen } = buildOperations(schema, messages);
    content = JSON.stringify(ops);
    kind = `extract:${chosen ?? 'none'}`;
  } else {
    const text = conversationText(messages) || system;
    content = `Summary: ${pickBusinessLine(text).slice(0, 300)}`;
    kind = 'summary';
  }
  return { kind, response: {
    id: `chatcmpl-mock-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model ?? 'mock',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  } };
}

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { /* ignore */ }
  const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const path = new URL(req.url, 'http://x').pathname;

  if (path === '/mode' && req.method === 'POST') { MODE = body.mode ?? MODE; return send(200, { mode: MODE }); }
  if (path.endsWith('/embeddings')) {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const dims = Number(body.dimensions) || 256;
    const b64 = body.encoding_format === 'base64';
    const data = inputs.map((t, i) => {
      const v = embed(typeof t === 'string' ? t : JSON.stringify(t), dims);
      return { object: 'embedding', index: i, embedding: b64 ? Buffer.from(v.buffer).toString('base64') : Array.from(v) };
    });
    log({ kind: 'embed', n: inputs.length, dims, b64 });
    return send(200, { object: 'list', data, model: body.model ?? 'mock-embed', usage: { prompt_tokens: 1, total_tokens: 1 } });
  }
  if (path.endsWith('/chat/completions')) {
    if (process.env.MOCK_LLM_DUMP) { try { appendFileSync(process.env.MOCK_LLM_DUMP, JSON.stringify(body) + '\n'); } catch {} }
    if (MODE === 'fail') { log({ kind: 'chat-429' }); return send(429, { error: { message: 'Rate limit reached (mock)', type: 'rate_limit' } }); }
    const { kind, response } = chatCompletion(body);
    log({ kind, tools: Array.isArray(body.tools) ? body.tools.length : 0, content: response.choices[0].message.content.slice(0, 400) });
    return send(200, response);
  }
  send(404, { error: { message: `mock has no ${path}` } });
}).listen(PORT, '127.0.0.1', () => console.log(`mock-llm listening on 127.0.0.1:${PORT} mode=${MODE}`));
