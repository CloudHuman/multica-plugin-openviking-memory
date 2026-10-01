// Judgements over an actual agent's reply and the recall results it acted on.

const NO_EVIDENCE = /没有|未找到|无相关|未提供|无法确认|暂无/;
const SAYS_INCOMPLETE = /(?:检索|召回|搜索|查询)(?:结果)?.{0,8}(?:未完成|不完整|超时|失败|中断)|结果(?:可能)?不完整|暂时无法确认|稍后(?:再|重新)?(?:查|试|检索)|timed? ?out|incomplete/i;

/**
 * "There is no memory of this" is only a supported answer after a complete
 * recall. When a scope timed out or failed, an empty result proves nothing:
 * the honest reply says the search was incomplete, and a flat "nothing found"
 * is inconclusive rather than a pass.
 */
export function assessNoAnswer({ reply, recalls }) {
  const answered = (recalls ?? []).filter((r) => r?.status === 'ok');
  if (!answered.length) {
    return { ok: false, verdict: 'no-recall', detail: 'The agent answered without an actual memory-recall' };
  }
  const incomplete = answered.flatMap((r) => r.result?.scopesSearched ?? []).filter((s) => s.timedOut || s.error);
  if (incomplete.length) {
    return SAYS_INCOMPLETE.test(reply)
      ? { ok: true, verdict: 'incomplete-acknowledged', detail: `${incomplete.length} recall scope(s) timed out or failed, and the agent said the search was incomplete` }
      : { ok: false, verdict: 'inconclusive', detail: `Inconclusive: ${incomplete.length} recall scope(s) timed out or failed, yet the agent answered as if no evidence existed` };
  }
  return NO_EVIDENCE.test(reply)
    ? { ok: true, verdict: 'no-evidence', detail: 'Actual agent acknowledged missing evidence after a complete recall' }
    : { ok: false, verdict: 'unsupported-answer', detail: 'Actual agent did not acknowledge missing evidence' };
}
