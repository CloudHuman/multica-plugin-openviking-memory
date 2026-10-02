import { createHash } from 'node:crypto';

// Narrow guards for execution controls seen in real archives. These are not a
// semantic classifier: business facts and explicitly lasting preferences still
// need the extractor's schema rules. Never rewrite the original archive.
const EXECUTION_CONTROL = [
  /(?:先|须|必须|应|before|must|first).{0,30}(?:调用\s*memory[-_ ]recall|memory[-_ ]recall)/i,
  /(?:memory[-_ ]recall|召回).{0,45}(?:引用.{0,12}(?:来源|URI)|实际证据|简短确认)/i,
  /(?:不|不要|禁止|未经明确要求不|do not|don't|must not).{0,10}(?:主动记录记忆|主动记忆|修改代码|创建\s*issue|创建唤醒规则|主动创建唤醒规则|modify code|create (?:an? )?issue|record memor)/i,
  /(?:按平台流程|提交简短(?:最终)?回复|只发布一次|后续完成通知只需确认|不要再次委派)/,
  /(?:MULTICA_TASK_ID|MULTICA_AGENT_ID|Never background-and-yield|Background Task Safety)/i,
];
const DURABLE_DOMAIN = /(?:以后|今后|始终|长期|一律|团队规范|发布冻结|冻结期|always|from now on|team policy|code freeze)/i;
const FAILED_RECALL = /(?:记忆(?:检索|搜索|召回)|检索|召回|memory (?:search|recall)).{0,65}(?:未(?:能)?找到|未检索到|没(?:有)?找到|无(?:可用|相关)|not found|no (?:relevant|available)|failed|timed? out)/i;
const NO_VALUE = /(?:未检索到|没(?:有)?查到|未找到|查不到).{0,40}(?:相关记忆|可用记忆|该数值|上限数字)/;
// An empty search reported as this run's outcome ("历史检索为空不影响确认", "本次召回为空").
// A product rule about empty results ("检索结果为空时显示提示") states a condition and stays.
const EMPTY_RECALL = /(?:记忆|本次|此次|这次)\s*(?:检索|召回|搜索)(?:结果)?\s*(?:为空|是空的?)(?!时)|(?:检索|召回|搜索)(?:结果)?\s*(?:为空|是空的?)(?!时)\s*[，,、]?\s*(?:不影响|无法|不能|暂无|因此|所以|故|但)/;
const recallOutcome = (text) => FAILED_RECALL.test(text) || NO_VALUE.test(text) || EMPTY_RECALL.test(text);
const PLATFORM_TOOL = /(?:multica.{0,35}(?:issue|CLI)|--description-file|mention:\/\/agent\/|执行智能体.{0,10}ID|最终状态:\s*(?:completed|failed))/i;

export function memoryQualityIssues(content) {
  const text = String(content ?? '');
  const issues = [];
  if (text.includes('# Multica Agent Runtime')) issues.push('runtime-brief');
  if (text.split(/\n|(?<=[。；;])/u).some(s => !DURABLE_DOMAIN.test(s) && EXECUTION_CONTROL.some(re => re.test(s)))) issues.push('execution-control');
  if (recallOutcome(text)) issues.push('retrieval-outcome');
  return issues;
}

/** A recall excerpt, not an altered source. Keep true facts around controls. */
export function memoryExcerpt(content, { uri = '' } = {}) {
  const raw = String(content ?? '');
  // Events remain historical evidence; a failed search is useful as a dated
  // event, but must never be offered as an entity fact or shared conclusion.
  const isEvent = /\/memories\/events\//.test(uri);
  const end = raw.indexOf('# Multica Agent Runtime');
  const withoutBrief = end < 0 ? raw : raw.slice(0, end);
  const front = withoutBrief.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const title = front?.[1].match(/^title:\s*(.+)$/m)?.[1]?.trim();
  let body = front ? withoutBrief.slice(front[0].length) : withoutBrief;
  // A curated file may name its subject only in frontmatter. Carry that title
  // into the excerpt so equal facts about different projects cannot collapse.
  if (title && !/^\s*#\s/m.test(body)) body = `# ${title}\n\n${body}`;
  const lines = body.split('\n').flatMap(line => {
    if (/^#{1,6}\s/.test(line)) return [line];
    return line.split(/(?<=[。；;])/u).filter(segment => {
      if (DURABLE_DOMAIN.test(segment)) return true;
      if (EXECUTION_CONTROL.some(re => re.test(segment))) return false;
      if (!isEvent && recallOutcome(segment)) return false;
      return true;
    }).join('');
  });
  const contentText = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const statements = contentText.split('\n').filter(line => line.trim() && !/^\s*#/.test(line));
  return { content: statements.length ? contentText : '', filtered: body !== raw || contentText !== body.trim() };
}

/** Sharing is stricter than scoped recall: uncertain candidates stay local. */
export function promotionQuality({ content, uri, maxContentChars = 3500 }) {
  const issues = memoryQualityIssues(content);
  if (issues.length) return { eligible: false, reasons: issues };
  // Platform usage learned from scaffolding is not a workspace business fact.
  // A substantive Multica decision/incident with no scaffolding is still valid.
  if (/\/memories\/entities\/[^/]+\/multica\.md$/i.test(uri) && PLATFORM_TOOL.test(content)) {
    return { eligible: false, reasons: ['platform-scaffolding'] };
  }
  if (String(content).length > maxContentChars) return { eligible: false, reasons: ['content-too-long'] };
  return { eligible: true, reasons: [] };
}

/** Exact normalized equality only; distinct numbers, conditions and dates stay. */
export function memoryFingerprint(content) {
  const raw = String(content ?? '');
  const front = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const title = front?.[1].match(/^title:\s*(.+)$/m)?.[1]?.trim();
  const body = front ? raw.slice(front[0].length) : raw;
  const text = `${title ? `title: ${title}\n` : ''}${body}`
    .split('\n').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean).join('\n');
  return createHash('sha256').update(text).digest('hex');
}
