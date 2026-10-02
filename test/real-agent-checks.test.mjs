import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessNoAnswer } from '../e2e/real-agent/answer-checks.mjs';
import { auditMemories, entityAuditIssues } from '../e2e/real-agent/memory-audit.mjs';
import { hasCurrentBudget } from '../e2e/real-agent/quality.mjs';

const recall = (scopesSearched) => ({ status: 'ok', result: { entries: [], scopesSearched } });
const complete = recall([{ scope: 'task:w:i', hits: 0 }, { scope: 'agent:w:a', hits: 0 }]);
const timedOut = recall([{ scope: 'task:w:i', hits: 0 }, { scope: 'agent:w:a', hits: 0, timedOut: true }]);

test('no-answer passes only when the empty answer follows a complete recall', () => {
  assert.equal(assessNoAnswer({ reply: '没有找到梧桐项目的相关记忆，无法确认负责人和日期。', recalls: [complete] }).verdict, 'no-evidence');
  // A timed-out scope makes "nothing found" unsupported: the real RAM-4 shape.
  const flat = assessNoAnswer({ reply: '没有找到梧桐项目的相关记忆，无法确认负责人和日期。', recalls: [timedOut] });
  assert.equal(flat.ok, false);
  assert.equal(flat.verdict, 'inconclusive');
  const honest = assessNoAnswer({ reply: '本次记忆检索超时，结果不完整，暂时无法确认负责人和日期，稍后再查。', recalls: [complete, timedOut] });
  assert.equal(honest.ok, true);
  assert.equal(honest.verdict, 'incomplete-acknowledged');
  assert.equal(assessNoAnswer({ reply: '没有相关记忆。', recalls: [] }).verdict, 'no-recall');
  assert.equal(assessNoAnswer({ reply: '没有相关记忆。', recalls: [{ status: 'error' }] }).verdict, 'no-recall');
  assert.equal(assessNoAnswer({ reply: '负责人是张三，10 月 8 日上线。', recalls: [complete] }).verdict, 'unsupported-answer');
  const failed = recall([{ scope: 'agent:w:a', hits: 0, error: 'HTTP 500' }]);
  assert.equal(assessNoAnswer({ reply: '没有相关记忆。', recalls: [failed] }).verdict, 'inconclusive');
});

const entityUri = 'viking://user/u/memories/entities/项目/海棠迁移.md';

test('entity cards are flagged for this workspace\'s issue keys and run bookkeeping', () => {
  // Lines from real extractions on 2026-10-01.
  const progress = '# 海棠迁移\n## 进度\n- 方案于 2026-10-01 在任务 RAM-1 下确认。\n- 该任务为隔离联调任务，无代码变更。';
  assert.deepEqual(entityAuditIssues(progress, { uri: entityUri, issuePrefix: 'RAM' }), ['entity-issue-key', 'entity-run-bookkeeping']);
  const relation = '## Relations\n- 2026-10-01 用户通过 RAM-2 任务查询苍鹭的最新业务约定，执行智能体依据 memory-recall 证据回复并引用来源 URI。';
  assert.deepEqual(entityAuditIssues(relation, { uri: entityUri, issuePrefix: 'RAM' }), ['entity-issue-key', 'entity-run-bookkeeping']);
  const clean = '# 苍鹭\n- 苍鹭项目发布使用 Apache Pulsar。\n- 项目每月预算为 8100 元（2026-10-01 更新）。\n- 模型选型参考 GPT-5 与 ISO-9001 流程。\n<!-- MEMORY_FIELDS {"source": "RAM-1 该任务为"} -->';
  assert.deepEqual(entityAuditIssues(clean, { uri: entityUri, issuePrefix: 'RAM' }), []);
  // Events legitimately record what happened in a run; only entity cards are checked.
  assert.deepEqual(entityAuditIssues(progress, { uri: 'viking://user/u/memories/events/2026-10-01/确认.md', issuePrefix: 'RAM' }), []);
  // Without a known prefix only the bookkeeping rule applies.
  assert.deepEqual(entityAuditIssues(progress, { uri: entityUri }), ['entity-run-bookkeeping']);
});

test('the memory audit reports entity observations without counting them as quality findings', async () => {
  const root = 'viking://user/u';
  const files = {
    [`${root}/memories/entities/项目/海棠迁移.md`]: '# 海棠迁移\n- 使用 RocketMQ。\n- 方案于 2026-10-01 在任务 RAM-1 下确认。',
    [`${root}/memories/entities/项目/苍鹭.md`]: '# 苍鹭\n- 苍鹭项目发布使用 Apache Pulsar。',
  };
  const directories = {
    [`${root}/memories`]: [{ name: 'entities', isDir: true }],
    [`${root}/memories/entities`]: [{ name: '项目', isDir: true }],
    [`${root}/memories/entities/项目`]: [{ name: '海棠迁移.md' }, { name: '苍鹭.md' }],
  };
  const ov = {
    listDir: async (_key, uri) => {
      if (!(uri in directories)) throw Object.assign(new Error('missing'), { status: 404 });
      return directories[uri];
    },
    readContent: async (_key, uri) => ({ content: files[uri] }),
  };
  const [audit] = await auditMemories({ ov, scopes: { 'task:ws:i': { userId: 'u', apiKey: 'key' } }, canary: 'canary', issuePrefix: 'RAM' });
  assert.equal(audit.complete, true);
  assert.deepEqual(audit.qualityFindings, []);
  assert.deepEqual(audit.entityFindings, [{ uri: `${root}/memories/entities/项目/海棠迁移.md`, reasons: ['entity-issue-key'] }]);
});

// Entity cards stored by real extractions on 2026-10-01 (native / account rules / account rules on OV defaults).
const CARD_NATIVE = '# 苍鹭\n用户参与的一个项目。\n## 技术约定\n- 发布使用 Apache Pulsar。\n- 存在双写机制，持续五天。\n## 预算与管理\n- 发布预算为 8100 元（2026-10-01 更新，此前为 7600 元）。';
const CARD_ACCOUNT = '# 苍鹭\n## 关键约定\n- 发布使用 Apache Pulsar（成员于 2026-10-01 确认）。\n- 每月预算为 8100 元（成员于 2026-10-01 更新确认，明确以本次更新为准；此前确认为 7600 元）。\n- 采用双写，持续五天（成员于 2026-10-01 确认）。';
const cardWith = (oldLine) => `# 苍鹭\n## 关键事实\n- 发布使用 Apache Pulsar (as of 2026-10-01)\n${oldLine}\n- 发布预算调整为 8100 元，其他约定不变，以本次更新为准 (as of 2026-10-01)\n- 双写持续五天 (as of 2026-10-01)`;

test('the current budget accepts a labelled previous value but not an unresolved one', () => {
  assert.equal(hasCurrentBudget(CARD_NATIVE), true);
  assert.equal(hasCurrentBudget(CARD_ACCOUNT), true);
  // The OV-defaults account card: the old value carries a note calling it the earlier agreement.
  assert.equal(hasCurrentBudget(cardWith('- 每月预算为 7600 元（2026-10-01 之前的约定）')), true);
  assert.equal(hasCurrentBudget(cardWith('- 每月预算为 7600 元（已作废）')), true);
  assert.equal(hasCurrentBudget(cardWith('- 每月预算为 7600 元 (previous agreement)')), true);
  // 2026-10-02 native card: the update names the old value as the one adjusted from.
  assert.equal(hasCurrentBudget('# 苍鹭\n- 发布使用 Apache Pulsar 作为消息中间件（2026-10-02 确认）。\n- 发布预算为 8100 元（2026-10-02 由 7600 元调整更新，以本次更新为准）。\n- 发布期间采用双写方案，持续五天。'), true);
  // Still rejected: an unlabelled old value, a note naming another amount as the earlier one,
  // "之前" as a verb rather than a label, and a card without the update.
  assert.equal(hasCurrentBudget(cardWith('- 每月预算为 7600 元 (as of 2026-10-01)')), false);
  assert.equal(hasCurrentBudget(cardWith('- 每月预算为 7600 元（之前为 8100 元）')), false);
  assert.equal(hasCurrentBudget(cardWith('- 每月预算为 7600 元（之前确认）')), false);
  assert.equal(hasCurrentBudget('# 苍鹭\n- 发布使用 Apache Pulsar。\n- 每月预算由 8100 元调整为 7600 元。\n- 双写持续五天。'), false);
  assert.equal(hasCurrentBudget(cardWith('- 每月预算 7600 元仍然有效（之前的约定已延续）')), false);
  assert.equal(hasCurrentBudget(cardWith('- 每月预算为 7600 元（之前的约定，仍然有效）')), false);
  assert.equal(hasCurrentBudget(cardWith('- 每月预算为 7600 元（原预算，当前执行）')), false);
  assert.equal(hasCurrentBudget('# 苍鹭\n- 发布使用 Apache Pulsar。\n- 每月预算为 7600 元。\n- 双写持续五天。'), false);
});
