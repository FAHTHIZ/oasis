// Ordered tool-call batching for the agent turn loop.
//
// Only adjacent calls of the same safe parallel class share a batch. A write,
// question, MCP call, or other non-parallel operation remains a barrier so a
// later read cannot observe state ahead of an earlier mutation.
// A model can emit dozens of reads in one reply; running them all at once
// risks EMFILE, provider rate limits on web tools and a burst of child
// processes. Claude Code caps tool concurrency at 10 by default too.
export const DEFAULT_MAX_PARALLEL_READS = 10;

// OASIS_MAX_TOOL_CONCURRENCY (or Claude Code's CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY)
// overrides the cap, up to 64.
export function maxParallelReadsFrom(env = process.env) {
  const raw = env && (env.OASIS_MAX_TOOL_CONCURRENCY || env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY);
  const value = Number.parseInt(String(raw || ''), 10);
  return Number.isInteger(value) && value > 0 ? Math.min(64, value) : DEFAULT_MAX_PARALLEL_READS;
}

export function planToolBatches(calls, {
  isReadOnly = () => false,
  isSpecialistReview = () => false,
  isTask = () => false,
  maxParallelTasks = 1,
  maxParallelReads = DEFAULT_MAX_PARALLEL_READS
} = {}) {
  if (!Array.isArray(calls) || calls.length === 0) return [];
  const batches = [];
  let cursor = 0;
  while (cursor < calls.length) {
    const first = calls[cursor];
    let kind = 'single';
    let canGroup = () => false;
    if (isReadOnly(first)) {
      kind = 'read-only';
      canGroup = isReadOnly;
    } else if (isSpecialistReview(first)) {
      kind = 'specialist-review';
      canGroup = isSpecialistReview;
    } else if (isTask(first)) {
      kind = 'subagent';
      canGroup = isTask;
    }
    let end = cursor + 1;
    while (end < calls.length && canGroup(calls[end])) end++;
    const batchCalls = calls.slice(cursor, end);
    const taskLimit = Number.isInteger(maxParallelTasks) && maxParallelTasks > 0 ? maxParallelTasks : 1;
    const readLimit = Number.isInteger(maxParallelReads) && maxParallelReads > 0 ? maxParallelReads : DEFAULT_MAX_PARALLEL_READS;
    batches.push({
      kind,
      calls: batchCalls,
      concurrency: kind === 'subagent' ? taskLimit : Math.min(batchCalls.length, readLimit)
    });
    cursor = end;
  }
  return batches;
}
