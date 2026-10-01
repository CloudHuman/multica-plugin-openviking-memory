import { listMemoryFiles } from '../../src/memory-inventory.mjs';
import { memoryFingerprint, memoryQualityIssues, promotionQuality } from '../../src/memory-quality.mjs';

export async function auditMemories({ ov, scopes, canary }) {
  const audit = [];
  for (const [scope, rec] of Object.entries(scopes)) {
    const inventory = await listMemoryFiles({ ov, key: rec.apiKey, userId: rec.userId });
    const errors = [...inventory.errors];
    const qualityFindings = [];
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
        const hash = memoryFingerprint(content);
        const copies = byHash.get(hash) ?? [];
        copies.push(file.uri); byHash.set(hash, copies);
      } catch (err) { errors.push({ uri: file.uri, reason: String(err.message ?? err) }); }
    }
    audit.push({
      scope, files: inventory.files.length, uris: inventory.files.map(f => f.uri), roots: inventory.roots,
      peerFiles: inventory.files.filter(f => /\/peers\/[^/]+\/memories\//.test(f.uri)).length,
      complete: errors.length === 0, errors, qualityFindings,
      exactDuplicates: [...byHash.values()].filter(copies => copies.length > 1),
      containsPlatformCanary: !!canary && allContent.includes(canary),
      containsRuntimeBanner: allContent.includes('# Multica Agent Runtime'),
      containsPlatformGuidance: /MULTICA_TASK_ID|MULTICA_AGENT_ID|Never background-and-yield|## Background Task Safety/.test(allContent),
    });
  }
  return audit;
}
