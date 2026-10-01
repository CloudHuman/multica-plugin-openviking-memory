import { listMemoryFiles } from '../../src/memory-inventory.mjs';
import { memoryFingerprint, memoryQualityIssues, promotionQuality } from '../../src/memory-quality.mjs';

// Run bookkeeping seen in real entity cards: the run, its test setup and its recall, not the subject.
const RUN_BOOKKEEPING = /(?:联调|隔离)任务|(?:无|没有|未)(?:代码变更|修改代码)|(?:本|该|此)(?:任务|运行)(?:为|是|中|下)|执行智能体|memory[-_ ]?recall|召回(?:证据|结果)|引用(?:来源|URI)/i;

/**
 * Observations about entity cards: this workspace's issue keys and run
 * bookkeeping. They describe OpenViking's native extraction, which the plugin
 * does not steer, so they are reported but never fail a suite, and they are
 * not part of promotion or recall filtering.
 */
export function entityAuditIssues(content, { uri = '', issuePrefix } = {}) {
  if (!/\/memories\/entities\//.test(uri)) return [];
  const text = String(content ?? '').replace(/<!--[\s\S]*?-->/g, ''); // MEMORY_FIELDS metadata is not card content
  const issues = [];
  if (issuePrefix && new RegExp(`(?<![A-Za-z0-9])${issuePrefix}-\\d+\\b`).test(text)) issues.push('entity-issue-key');
  if (RUN_BOOKKEEPING.test(text)) issues.push('entity-run-bookkeeping');
  return issues;
}

export async function auditMemories({ ov, scopes, canary, issuePrefix }) {
  const audit = [];
  for (const [scope, rec] of Object.entries(scopes)) {
    const inventory = await listMemoryFiles({ ov, key: rec.apiKey, userId: rec.userId });
    const errors = [...inventory.errors];
    const qualityFindings = [];
    const entityFindings = [];
    const byHash = new Map();
    let allContent = '';
    for (const file of inventory.files) {
      try {
        const content = (await ov.readContent(rec.apiKey, file.uri, { limit: 5000 })).content;
        if (typeof content !== 'string') throw new Error('memory content missing');
        if (content.split('\n').length >= 5000) errors.push({ uri: file.uri, reason: 'content-read-limit' });
        allContent += `\n${content}`;
        const reusable = /\/memories\/(?:entities|preferences|experiences|cases)\//.test(file.uri);
        const reasons = reusable ? promotionQuality({ content, uri: file.uri, maxContentChars: Infinity }).reasons : memoryQualityIssues(content).filter(r => r === 'runtime-brief');
        if (reasons.length) qualityFindings.push({ uri: file.uri, reasons });
        const observed = entityAuditIssues(content, { uri: file.uri, issuePrefix });
        if (observed.length) entityFindings.push({ uri: file.uri, reasons: observed });
        const hash = memoryFingerprint(content);
        const copies = byHash.get(hash) ?? [];
        copies.push(file.uri); byHash.set(hash, copies);
      } catch (err) { errors.push({ uri: file.uri, reason: String(err.message ?? err) }); }
    }
    audit.push({
      scope, files: inventory.files.length, uris: inventory.files.map(f => f.uri), roots: inventory.roots,
      peerFiles: inventory.files.filter(f => /\/peers\/[^/]+\/memories\//.test(f.uri)).length,
      complete: errors.length === 0, errors, qualityFindings, entityFindings,
      exactDuplicates: [...byHash.values()].filter(copies => copies.length > 1),
      containsPlatformCanary: !!canary && allContent.includes(canary),
      containsRuntimeBanner: allContent.includes('# Multica Agent Runtime'),
      containsPlatformGuidance: /MULTICA_TASK_ID|MULTICA_AGENT_ID|Never background-and-yield|## Background Task Safety/.test(allContent),
    });
  }
  return audit;
}
