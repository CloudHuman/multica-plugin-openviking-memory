import { createHash } from 'node:crypto';

// Narrow guards for execution controls seen in real archives. These are not a
// semantic classifier: business facts and explicitly lasting preferences still
// need the extractor's schema rules. Never rewrite the original archive.
// Each pattern is tried on one clause at a time (see markControls).
const EXECUTION_CONTROL = [
  /(?:先|须|必须|应|before|must|first).{0,30}(?:调用\s*memory[-_ ]recall|memory[-_ ]recall)/i,
  /(?:memory[-_ ]recall|召回).{0,45}(?:引用.{0,12}(?:来源|URI)|实际证据|简短确认)/i,
  // An order to the agent opening its clause ("不要修改代码", "无需主动写记忆").
  // A rule about the business is not one: "上线前一周不允许修改代码",
  // "客户不希望我们修改代码库结构", "支付回调失败时不要创建新 issue".
  /^\s*(?:请\s*)?(?:除(?:非)?(?:明确)?要求(?:以)?外\s*)?(?:不要|无需|无须|不用|不必|请勿|禁止|别|未经明确要求不要?|不)\s*(?:再|擅自|自行)?\s*(?:主动(?:写入?|记录|保存)?记忆|修改代码|创建\s*(?:新\s*)?issue|(?:主动)?创建唤醒规则)/i,
  /^\s*(?:please\s+)?(?:do not|don't|must not|never)\s+(?:modify (?:the )?code|create (?:an? )?(?:new )?issue|record memor)/i,
  // How this run's reply is published; "每个版本的公告只发布一次" is a business rule.
  /(?:按平台流程(?:提交|发布)|提交简短(?:最终)?回复|(?:评论|回复|comment).{0,30}只发布一次|后续完成通知只需确认|不要再次委派)/i,
  // How to end this run, as a clause of its own ("之后结束", "请简短确认后结束").
  /^\s*请?(?:简短确认(?:后|即可)?|确认后|之后|然后|随后)\s*结束\s*[。.!！]?\s*$/u,
  /(?:MULTICA_TASK_ID|MULTICA_AGENT_ID|Never background-and-yield|Background Task Safety)/i,
  // How to word this run's reply ("按实际证据回复", "引用来源 URI"); "研究报告必须引用来源链接" stays.
  /(?:按|依据|根据|基于)(?:实际|召回的?)?证据(?:回复|作答|回答)|引用(?:记忆|召回的?)?来源\s*URI/i,
];
const DURABLE_DOMAIN = /(?:以后|今后|始终|长期|一律|团队规范|发布冻结|冻结期|always|from now on|team policy|code freeze)/i;
const FAILED_RECALL = /(?:记忆(?:检索|搜索|召回)|检索|召回|memory (?:search|recall)).{0,65}(?:未(?:能)?找到|未检索到|没(?:有)?找到|无(?:可用|相关)|not found|no (?:relevant|available)|failed|timed? out)/i;
const NO_VALUE = /(?:未检索到|没(?:有)?查到|未找到|查不到).{0,40}(?:相关记忆|可用记忆|该数值|上限数字)/;
// An empty search reported as this run's outcome ("历史检索为空不影响确认", "本次召回为空",
// "检索为空，因此以成员确认为准"). A product rule about empty results states a
// condition or what the product does next and stays: "检索结果为空时显示提示",
// "搜索结果为空，因此显示默认推荐列表", "商品搜索结果为空，但要展示热门商品".
const EMPTY_RECALL = /(?:记忆|本次|此次|这次)\s*(?:检索|召回|搜索)(?:结果)?\s*(?:为空|是空的?)(?!时)|(?:检索|召回|搜索)(?:结果)?\s*(?:为空|是空的?)(?!时)\s*[，,、]?\s*(?:不影响|无法|不能|暂无|(?:因此|所以|故|但)\s*(?:仍|还是|只能|先)?\s*(?:以|按|无法|不能|暂无|未|没有))/;
const CLAUSE_END = /(?<=[，,、：:])/u;
const CONDITION = /(?:时|的话|如果|若|假如|when\b|if\b)/i;
const LIST_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/u;
// A clause that is itself a condition for what follows ("支付回调失败时，", "如果超时，").
const CONDITION_CLAUSE = /^\s*(?:如果|若|假如|假设|when\b|if\b)|(?:时|的话)\s*[，,、：:]?\s*$/i;
// The search itself, not a noun beside it ("历史数据检索 failed 的告警" is a business rule).
const RUN_SEARCH = /(?:记忆|历史|本次|此次|这次|memory)\s*的?\s*(?:检索|召回|搜索|search|recall)/i;
// A remark on a search's outcome ("本次记忆检索未能找到该数值"); nothing stated as a
// condition ("检索无相关结果时显示空状态") is one. Archive, recall and promotion share it.
const searchOutcome = (text) => !CONDITION.test(text)
  && (EMPTY_RECALL.test(text) || NO_VALUE.test(text) || (FAILED_RECALL.test(text) && RUN_SEARCH.test(text)));
const recallOutcome = (text) => String(text).split(/\n|(?<=[。；;])/u).some(searchOutcome);

/**
 * Each clause of a sentence, marked when it only steers this run. A clause
 * stated as a condition is no control, and after a clause that sets up a
 * condition neither is the rest: "支付回调失败时，不要创建新 issue，直接重试三次"
 * says what to do in that case.
 */
function markControls(sentence) {
  let conditioned = false;
  return String(sentence).split(CLAUSE_END).map((clause) => {
    const text = clause.replace(LIST_MARKER, '');
    const control = !conditioned && !CONDITION.test(text) && EXECUTION_CONTROL.some(re => re.test(text));
    if (CONDITION_CLAUSE.test(text)) conditioned = true;
    return { clause, control };
  });
}
// A sentence with a control clause; a stated lasting policy has none.
const runControl = (segment) => !DURABLE_DOMAIN.test(segment) && markControls(segment).some((c) => c.control);

/**
 * One sentence without its run-control clauses, so the facts beside them stay:
 * "方案确认：不修改代码，只调整分区数为 12。" keeps "方案确认：只调整分区数为 12。".
 * A sentence stating a lasting policy stays whole; nothing left means ''.
 */
function withoutControlClauses(sentence) {
  if (!runControl(sentence)) return sentence;
  const kept = markControls(sentence).filter((c) => !c.control).map((c) => c.clause);
  let rest = kept.join('').replace(/[，,、：:\s]+$/u, '');
  if (!rest.replace(/[\s，,、：:。；;.!?！？-]/gu, '')) return '';
  // A list item keeps its marker when the dropped clause carried it.
  const marker = sentence.match(LIST_MARKER)?.[0] ?? '';
  if (marker && !rest.startsWith(marker)) rest = `${marker}${rest.trimStart()}`;
  const end = sentence.match(/[。；;.!?！？]\s*$/u)?.[0].trim() ?? '';
  return rest.endsWith(end) ? rest : `${rest}${end}`;
}
const PLATFORM_TOOL = /(?:multica.{0,35}(?:issue|CLI)|--description-file|mention:\/\/agent\/|执行智能体.{0,10}ID|最终状态:\s*(?:completed|failed))/i;

export function memoryQualityIssues(content) {
  const text = String(content ?? '');
  const issues = [];
  if (text.includes('# Multica Agent Runtime')) issues.push('runtime-brief');
  if (text.split(/\n|(?<=[。；;])/u).some(runControl)) issues.push('execution-control');
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
    return line.split(/(?<=[。；;])/u).map(segment => {
      if (DURABLE_DOMAIN.test(segment)) return segment;
      const kept = withoutControlClauses(segment);
      return !isEvent && recallOutcome(kept) ? '' : kept;
    }).join('');
  });
  const contentText = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const statements = contentText.split('\n').filter(line => line.trim() && !/^\s*#/.test(line));
  return { content: statements.length ? contentText : '', filtered: body !== raw || contentText !== body.trim() };
}

// A member's remark on this run's own search ("历史检索为空不影响确认") is no
// business fact either; it is removed clause by clause before archiving.

/**
 * One sentence without the clauses that report this run's search. A sentence
 * no single clause of which reports it ("搜索结果为空，因此显示默认推荐列表")
 * stays whole.
 */
function withoutRecallOutcome(sentence) {
  if (DURABLE_DOMAIN.test(sentence) || !searchOutcome(sentence)) return sentence;
  const clauses = sentence.split(CLAUSE_END);
  const kept = clauses.filter(clause => !searchOutcome(clause));
  if (kept.length === clauses.length) return sentence;
  const rest = kept.join('').replace(/[，,、：:\s]+$/u, '');
  if (!rest.replace(/[\s，,、：:。；;.!?！？-]/gu, '')) return '';
  const end = sentence.match(/[。；;.!?！？]\s*$/u)?.[0].trim() ?? '';
  return rest.endsWith(end) ? rest : `${rest}${end}`;
}

/**
 * A message without its known one-run controls ("请先调用 memory-recall",
 * "不要修改代码", "按平台流程提交简短回复") and remarks on this run's search
 * ("历史检索为空不影响确认"), clause by clause. The rest of the message,
 * headings, lasting policies and empty-result product rules included, is kept
 * as written.
 */
export function withoutRunControls(text) {
  return String(text ?? '').split('\n')
    .map(line => /^#{1,6}\s/.test(line) ? line : line.split(/(?<=[。；;])/u).map(sentence => withoutRecallOutcome(withoutControlClauses(sentence))).join('').trimEnd())
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
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
