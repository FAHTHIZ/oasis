// Ordered tool-call batching for the agent turn loop.
//
// Only adjacent calls of the same safe parallel class share a batch. A write,
// question, MCP call, or other non-parallel operation remains a barrier so a
// later read cannot observe state ahead of an earlier mutation.
export function planToolBatches(calls, {
  isReadOnly = () => false,
  isSpecialistReview = () => false,
  isTask = () => false,
  maxParallelTasks = 1
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
    batches.push({
      kind,
      calls: batchCalls,
      concurrency: kind === 'subagent' ? taskLimit : batchCalls.length
    });
    cursor = end;
  }
  return batches;
}
