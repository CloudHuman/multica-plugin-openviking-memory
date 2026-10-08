import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryExcerpt, memoryFingerprint, promotionQuality, withoutRunControls } from '../src/memory-quality.mjs';
import { listMemoryFiles } from '../src/memory-inventory.mjs';
import { auditMemories } from '../e2e/real-agent/memory-audit.mjs';
import { hasCurrentBudget } from '../e2e/real-agent/quality.mjs';

test('real mixed DM preference keeps its layout but drops adjacent run controls', () => {
  const content = '- 蓝鹊周报固定按“风险、进展、下一步”三个中文标题，且风险放第一。\n- 该周报属私聊内容，不写入公共记忆，不创建 issue，不修改代码。\n- 回应前先调用 memory-recall，再做简短确认。';
  const result = memoryExcerpt(content, { uri: 'viking://user/u/peers/member/memories/preferences/u/蓝鹊周报.md' });
  assert.match(result.content, /风险、进展、下一步/);
  assert.doesNotMatch(result.content, /不修改代码|memory-recall|不创建 issue/);
  assert.equal(result.filtered, true);
  assert.equal(promotionQuality({ content, uri: 'viking://user/u/memories/preferences/任务要求.md' }).eligible, false);
});

test('business constraints and lasting coding choices survive the execution guard', () => {
  for (const content of [
    '青岚仓库采用 NATS JetStream，每月成本上限 2450 元。',
    '黄鹂巡检的固定告警阈值为错误率超过 3.5%。',
    '以后代码注释一律使用中文，对外 API 保持驼峰命名。',
    '发布冻结期不要修改代码；安全热修复须经负责人批准。',
  ]) {
    assert.equal(promotionQuality({ content, uri: 'viking://user/u/memories/entities/项目/约定.md' }).eligible, true, content);
    assert.equal(memoryExcerpt(content).content, content);
  }
});

test('a failed recall is historical evidence, not an entity fact or shared knowledge', () => {
  const content = '# 雨燕项目\n- 项目名称：雨燕项目。\n- 据称确定过重试上限，但本次记忆检索未能找到该数值。';
  assert.deepEqual(promotionQuality({ content, uri: 'viking://user/u/memories/entities/项目/雨燕项目.md' }).reasons, ['retrieval-outcome']);
  assert.doesNotMatch(memoryExcerpt(content, { uri: 'viking://user/u/memories/entities/项目/雨燕项目.md' }).content, /未能找到/);
  assert.match(memoryExcerpt(content, { uri: 'viking://user/u/memories/events/搜索故障.md' }).content, /未能找到/);
});

test('an empty search reported as an outcome is filtered, an empty-result product rule is not', () => {
  const uri = 'viking://user/u/memories/entities/项目/苍鹭.md';
  // Line from a real native extraction on 2026-10-02.
  const card = '# 苍鹭蒸馏项目\n- 每月预算为 8100 元。\n- 2026-10-02 成员正式确认上述约定，作为直接证据，历史检索为空不影响确认。';
  assert.deepEqual(promotionQuality({ content: card, uri }).reasons, ['retrieval-outcome']);
  const excerpt = memoryExcerpt(card, { uri });
  assert.match(excerpt.content, /8100 元/);
  assert.doesNotMatch(excerpt.content, /检索为空/);
  for (const outcome of ['记忆检索为空，无法确认负责人。', '本次召回结果为空。', '检索为空，因此以成员确认为准。']) {
    assert.deepEqual(promotionQuality({ content: outcome, uri }).reasons, ['retrieval-outcome'], outcome);
  }
  for (const rule of ['检索结果为空时显示提示。', '召回为空时降级到全文搜索。', '新用户历史检索为空，推荐热门词。', '搜索结果为空的页面需要展示引导。']) {
    assert.equal(promotionQuality({ content: rule, uri }).eligible, true, rule);
    assert.equal(memoryExcerpt(rule, { uri }).content, rule);
  }
  // Events keep it as dated history.
  assert.match(memoryExcerpt(card, { uri: 'viking://user/u/memories/events/2026/10/02/确认.md' }).content, /检索为空/);
});

test('shared platform scaffolding is rejected without blocking substantive platform decisions', () => {
  const uri = 'viking://user/u/memories/entities/工作平台/multica.md';
  assert.deepEqual(promotionQuality({ uri, content: '# Multica\n创建 issue 可通过 multica CLI 完成，支持 --description-file。' }).reasons, ['platform-scaffolding']);
  assert.equal(promotionQuality({ uri, content: '# Multica\n团队确认升级到 0.6.0，迁移窗口为每周二 22:00。' }).eligible, true);
});

test('normalized fingerprints preserve different amounts, dates and project identities', () => {
  const base = '# 苍鹭发布\n- 月度预算为 8100 元（截至 2026-10-01）。';
  assert.equal(memoryFingerprint(base), memoryFingerprint(`---\ncreated_at: anything\n---\n${base}\n`));
  for (const different of [base.replace('8100', '7600'), base.replace('2026-10-01', '2026-10-02'), base.replace('苍鹭', '青岚')]) {
    assert.notEqual(memoryFingerprint(base), memoryFingerprint(different));
  }
  const namedOnlyInHeader = name => `---\ntitle: ${name}\ncreated_at: now\n---\n- 月度预算 8100 元，双写持续五天。`;
  assert.notEqual(memoryFingerprint(namedOnlyInHeader('苍鹭')), memoryFingerprint(namedOnlyInHeader('青岚')));
  assert.notEqual(memoryExcerpt(namedOnlyInHeader('苍鹭')).content, memoryExcerpt(namedOnlyInHeader('青岚')).content);
});

test('current-budget verification accepts labelled history and rejects an unresolved old current value', () => {
  const facts = '- 使用 Apache Pulsar。\n- 双写持续五天。\n';
  assert.equal(hasCurrentBudget(facts + '- 每月发布预算为 8100 元（此前为 7600 元）。'), true);
  assert.equal(hasCurrentBudget(facts + '- 每月预算为 7600 元。\n- 另有 8100 元预算说法。'), false);
  assert.equal(hasCurrentBudget(facts + '- 每月预算为 8100 元。\n- 每月预算为 7600 元。'), false);
  // Wording seen from a real extraction model: 7600 is explicitly superseded.
  assert.equal(hasCurrentBudget(facts + '- 发布预算为 8100 元（成员于 2026-10-01 正式更新，取代同日较早确认的每月 7600 元）。'), true);
  assert.equal(hasCurrentBudget(facts + '- 每月预算为 8100 元。\n- 7600 元的预算已被取代。'), true);
  assert.equal(hasCurrentBudget(facts + '- Monthly budget is 8100 元 (supersedes the earlier 7600).'), true);
  // An old value still presented as current does not pass, whatever the wording around 8100.
  assert.equal(hasCurrentBudget(facts + '- 每月预算为 8100 元。\n- 7600 元取代了 8100 元的提案。'), false);
});

test('inventory covers own and peer memories, omits bootstrap/stubs, and reports incomplete reads', async () => {
  const root = 'viking://user/u';
  const directories = {
    [`${root}/memories`]: [{ name: 'identity.md' }, { name: '.overview.md' }, { name: 'entities', isDir: true }],
    [`${root}/memories/entities`]: [{ name: '项目.md' }],
    [`${root}/peers`]: [{ name: 'member', is_dir: true }],
    [`${root}/peers/member/memories`]: [{ name: '偏好.md' }],
  };
  const ov = { listDir: async (_key, uri) => {
    if (!(uri in directories)) throw Object.assign(new Error('missing'), { status: 404 });
    return directories[uri];
  } };
  const inventory = await listMemoryFiles({ ov, key: 'key', userId: 'u' });
  assert.equal(inventory.complete, true);
  assert.deepEqual(inventory.files.map(f => f.uri), [`${root}/memories/entities/项目.md`, `${root}/peers/member/memories/偏好.md`]);
  const bounded = await listMemoryFiles({ ov, key: 'key', userId: 'u', maxFiles: 1 });
  assert.equal(bounded.complete, false);
  const audit = await auditMemories({ ov: { ...ov, readContent: async () => { throw new Error('read failed'); } }, scopes: { 'dm:ws:a:m': { userId: 'u', apiKey: 'key' } }, canary: 'canary' });
  assert.equal(audit[0].peerFiles, 1);
  assert.equal(audit[0].complete, false);
  assert.equal(audit[0].errors.length, 2);
});

test('inventory does not follow a peer entry into another user namespace', async () => {
  const requested = [];
  const ov = { listDir: async (_key, uri) => {
    requested.push(uri);
    return uri.endsWith('/peers') ? [{ uri: 'viking://user/other/peers/m', isDir: true }] : [];
  } };
  await listMemoryFiles({ ov, key: 'key', userId: 'u' });
  assert.ok(requested.every(uri => uri.startsWith('viking://user/u/')));
});

test('run controls are removed sentence by sentence; facts, headings and lasting policies stay', () => {
  assert.equal(withoutRunControls('预算 7600 元。请先调用 memory-recall，按实际证据回复。双写五天。'), '预算 7600 元。双写五天。');
  assert.equal(withoutRunControls('## 要求\n发布冻结期间一律不要修改代码。\n只做分析。'), '## 要求\n发布冻结期间一律不要修改代码。\n只做分析。');
  assert.equal(withoutRunControls('不要修改代码，不要主动记录记忆。'), '');
  assert.equal(withoutRunControls('检索结果为空时显示提示。'), '检索结果为空时显示提示。', 'search outcomes are not run controls');
});
