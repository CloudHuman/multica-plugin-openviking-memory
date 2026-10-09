import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runQuality } from '../e2e/real-agent/quality.mjs';

// The quality suite over a scripted stack: what native extraction "writes" is
// fixed per run, so the paths a real model takes only sometimes (nothing to
// promote, no private layout) run every time.
const WS = 'ws-1';
const A = { id: 'agent-a' };
const USER = { token: 't', userId: 'member-1' };
const CARD = '# 苍鹭\n- 发布使用 Apache Pulsar。\n- 每月预算为 8100 元（此前为 7600 元）。\n- 双写持续五天。\n- 项目代码注释一律使用中文。';
const EVENT = '# Summary\n成员确认苍鹭发布使用 Apache Pulsar，每月预算 7600 元，双写持续五天。';

function fakeStack({ updateWritesCard }) {
  const state = mkdtempSync(join(tmpdir(), 'ovmem-quality-flow-'));
  const pluginState = join(state, 'plugin');
  const space = (scope, userId) => [scope, { apiKey: `key-${userId}`, userId }];
  const scopes = Object.fromEntries([
    space(`task:${WS}:issue-1`, 'u-task'), space(`task:${WS}:issue-2`, 'u-task-b'),
    space(`shared:${WS}`, 'u-shared'), space(`dm:${WS}:${A.id}:${USER.userId}`, 'u-dm'),
  ]);
  const files = new Map();
  const userOf = (key) => key.replace(/^key-/, '');
  const mem = (userId, path) => `viking://user/${userId}/memories/${path}`;
  const done = (ref) => appendFileSync(join(pluginState, 'archives.jsonl'), `${JSON.stringify({ type: 'extraction', ref, extraction: 'done' })}\n`);
  const missing = () => Object.assign(new Error('not found'), { status: 404 });
  const ov = {
    async listDir(_key, uri) {
      const prefix = `${uri.replace(/\/$/, '')}/`;
      const children = new Map();
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue;
        const [name, ...rest] = path.slice(prefix.length).split('/');
        children.set(name, rest.length > 0);
      }
      if (!children.size) throw missing();
      return [...children].map(([name, isDir]) => ({ name, isDir }));
    },
    async readContent(_key, uri) {
      if (!files.has(uri)) throw missing();
      return { content: files.get(uri) };
    },
    async search(key) {
      const root = `viking://user/${userOf(key)}/`;
      return { memories: [...files.keys()].filter((uri) => uri.startsWith(root)).map((uri) => ({ uri, context_type: 'memory' })) };
    },
  };

  const tasks = [];
  const created = { issues: [] };
  let n = 0;
  const finishTask = (task, effects) => { tasks.push({ status: 'completed', ...task }); effects?.(); done(task.id); };
  const sharedCard = mem('u-shared', 'entities/项目/苍鹭.md');
  const recallResult = { status: 'ok', result: { run: { bound: true }, entries: [{ scope: `shared:${WS}`, uri: sharedCard }] } };
  const mc = {
    async must(_label, promise) { const r = await promise; if (r.status >= 300) throw new Error(`HTTP ${r.status}`); return r.json; },
    async call(path, { method = 'GET', body } = {}) {
      const ok = (json) => ({ status: 200, json });
      if (path === '/api/agents' && method === 'POST') return ok({ id: 'agent-b' });
      let m = path.match(/^\/api\/agents\/([^/]+)\/tasks/);
      if (m) return ok(tasks.filter((t) => t.agent_id === m[1]));
      m = path.match(/^\/api\/tasks\/([^/]+)\/messages/);
      if (m) {
        const task = tasks.find((t) => t.id === m[1]);
        if (task.agent_id === 'agent-b') return ok([{ type: 'tool_result', tool: 'memory-recall', output: JSON.stringify(recallResult) }]);
        return ok([{ type: 'text', content: '已确认。' }]);
      }
      m = path.match(/^\/api\/issues\/([^/]+)\/comments$/);
      if (m) {
        const task = tasks.find((t) => t.issue_id === m[1] && t.agent_id === 'agent-b');
        return ok(task ? [{ source_task_id: task.id, author_type: 'agent', content: `苍鹭发布使用 Pulsar，每月预算 8100 元，双写五天。来源：${sharedCard}` }] : []);
      }
      if (path === '/api/chat/sessions' && method === 'POST') return ok({ id: 'chat-1' });
      m = path.match(/^\/api\/chat\/sessions\/([^/]+)\/messages$/);
      if (m && method === 'POST') {
        const id = `task-${++n}`;
        finishTask({ id, agent_id: A.id, chat_session_id: m[1] }); // the private chat: extraction writes nothing
        return ok({ task_id: id });
      }
      if (m) return ok([]);
      if (/\/cancel$/.test(path)) return ok({});
      throw new Error(`unexpected multica call ${method} ${path} ${JSON.stringify(body ?? '')}`);
    },
    async createIssue(_token, _ws, { title }) { const issue = { id: `issue-${created.issues.length + 1}`, title }; created.issues.push(issue); return issue; },
    async assign(_token, _ws, issueId, agentId) {
      const id = `task-${++n}`;
      // The seed run: native extraction writes only an event, nothing to promote.
      finishTask({ id, agent_id: agentId, issue_id: issueId }, () => { if (issueId === 'issue-1') files.set(mem('u-task', 'events/2026/10/08/苍鹭约定确认.md'), EVENT); });
    },
    async comment(_token, _ws, issueId) {
      finishTask({ id: `task-${++n}`, agent_id: A.id, issue_id: issueId }, () => { if (updateWritesCard) files.set(mem('u-task', 'entities/项目/苍鹭.md'), CARD); });
    },
  };
  const consolidate = () => {
    const card = mem('u-task', 'entities/项目/苍鹭.md');
    if (!files.has(card)) return { promoted: [], skipped: [], note: 'nothing new to promote' };
    files.set(sharedCard, CARD);
    const sessionId = `mc-consolidate-${++n}`;
    done(sessionId);
    return { session_id: sessionId, promoted: [{ file: '苍鹭.md', from: `task:${WS}:issue-1` }], skipped: [] };
  };
  return { state, pluginState, scopes, ov, mc, tasks, created, consolidate };
}

async function runSuite({ updateWritesCard }) {
  const stack = fakeStack({ updateWritesCard });
  const { mkdirSync } = await import('node:fs');
  mkdirSync(stack.pluginState, { recursive: true });
  writeFileSync(join(stack.pluginState, 'scopes.json'), JSON.stringify({ scopes: stack.scopes }));
  writeFileSync(join(stack.pluginState, 'extractions.json'), JSON.stringify({ pending: {} }));
  const results = [];
  const report = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/admin\/consolidate$/);
    return { ok: true, status: 200, json: async () => ({ result: stack.consolidate() }) };
  };
  try {
    await runQuality({
      mc: stack.mc, ov: stack.ov, user: USER, ws: WS, agent: A, agentTemplate: {}, pluginState: stack.pluginState,
      pluginUrl: 'https://plugin.test', pluginToken: 'p', report, save: () => {}, state: stack.state, run: 'r',
      step: (id, ok, detail) => results.push({ id, ok: !!ok, detail }),
      wait: async (label, fn) => { for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 2)); } throw new Error(`Timed out waiting for ${label}`); },
      privateFile: () => {}, toolResultData: (m) => JSON.parse(m.output), canary: 'CANARY', issuePrefix: 'RAM', resume: false,
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  return { results: Object.fromEntries(results.map((r) => [r.id, r])), report, stack };
}

test('an empty first promotion and a missing private layout are recorded, and the run goes on', async () => {
  const { results, report, stack } = await runSuite({ updateWritesCard: true });
  const outcome = Object.fromEntries(Object.entries(results).map(([id, r]) => [id, r.ok]));
  assert.deepEqual(outcome, {
    'automatic-fact-fidelity': true, 'lasting-preference-retained': false, 'no-active-write-shortcut': true,
    'initial-promotion-admitted': false,
    'current-entity-update': true, 'historical-budget-retained': true, 'entity-category-stable': false, 'updated-uri-repromoted': false,
    'real-B-current-shared-recall': true, 'real-B-task-delivery': true,
    'dm-distilled-peer-layout': false, 'real-DM-layout-recall': false,
    'peer-audit-coverage': false, 'reusable-memory-hygiene': true, 'runtime-markers-filtered': true,
  });
  assert.match(results['initial-promotion-admitted'].detail, /nothing new to promote/);
  assert.match(results['real-DM-layout-recall'].detail, /Skipped: no private layout was extracted/);
  assert.equal(report.promotions.length, 2, 'both promotions are kept in the report');
  assert.ok(stack.created.issues.some((i) => i.title.includes('另一智能体')), 'B still ran once shared memory had the facts');
});

test('when nothing ever reaches shared memory, B is not asked and the private-chat checks still run', async () => {
  const { results, stack } = await runSuite({ updateWritesCard: false });
  assert.equal(results['real-B-current-shared-recall'].ok, false);
  assert.match(results['real-B-current-shared-recall'].detail, /Skipped: nothing was promoted/);
  assert.equal(results['real-B-task-delivery'], undefined, 'B\'s delivery is not judged when B did not run');
  assert.equal(stack.created.issues.length, 1, 'no question was put to B');
  assert.equal(results['dm-distilled-peer-layout'].ok, false);
  assert.ok(results['runtime-markers-filtered'], 'the audit ran to the end');
});
