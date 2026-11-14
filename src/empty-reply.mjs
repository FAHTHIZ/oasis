// Browser-safe (no Node imports): empty-reply handling shared by the CLI
// agent (completion-gates.mjs, via turn-guards.mjs) and the browser app
// (app/core/agent.mjs). An empty reply (no text, no tool call) is not an
// answer: ask again, then say so instead of ending with nothing.
export const MAX_EMPTY_REPLY_NUDGES = 2;
export const EMPTY_REPLY_NUDGE = '<system-reminder>Your last reply was empty: no text and no tool call. Continue the task: call a tool, or give your final answer to the user in plain text.</system-reminder>';
export const EMPTY_REPLY_NOTICE = 'The model ended its turn without a reply (it returned an empty response ' + (MAX_EMPTY_REPLY_NUDGES + 1) + ' times). Nothing was summarized; ask again or try another model.';

// A provider-side stop (content filter, refusal, error finish) comes back the
// same way on a re-ask, so it is reported instead of retried.
export function providerStopNotice(stop) {
  return 'The provider ended the reply with no text (finish reason: ' + stop + '). Nothing was summarized; rephrase the request or try another model.';
}
