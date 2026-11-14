// What one task did, in one place: which models ran and why, whether it
// escalated or fell back, how many requests and tokens it took, what it cost,
// what the prompt cache saved, and whether it finished verified.
//
// Every figure says where it came from. Token counts are provider-reported
// unless a request had no usage report (then estimated from text length).
// Cost is OASIS's price-table estimate unless every request carried the
// provider's own charge (OpenRouter's usage.cost), which is then shown as
// provider-reported. The report covers requests made by this OASIS process;
// external CLIs, MCP servers and hooks that call models themselves are not in it.

export function newRunTracker() {
  return { models: new Map(), requests: 0, sideRequests: 0, estimatedRequests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, estimatedCostUsd: 0, costKnown: true, providerCostUsd: 0, providerCostRequests: 0, fallbacks: [], started: Date.now() };
}

/** Adds one onUsage entry (a model request, or a compaction/advisor side call). */
export function trackUsage(tracker, entry = {}, fallbackModel = '') {
  if (!tracker || !entry) return;
  const input = Math.max(0, Number(entry.inputTokens) || 0);
  const output = Math.max(0, Number(entry.outputTokens) || 0);
  tracker.inputTokens += input;
  tracker.outputTokens += output;
  tracker.cacheReadTokens += Math.max(0, Number(entry.cacheReadTokens) || 0);
  tracker.cacheCreationTokens += Math.max(0, Number(entry.cacheCreationTokens) || 0);
  if (entry.estimated) tracker.estimatedRequests += 1;
  if (entry.costKnown === false) tracker.costKnown = false;
  else tracker.estimatedCostUsd += Math.max(0, Number(entry.costUsd) || 0);
  if (typeof entry.providerCostUsd === 'number') { tracker.providerCostUsd += entry.providerCostUsd; tracker.providerCostRequests += 1; }
  if (entry.phase !== undefined || entry.subagent) { tracker.sideRequests += 1; return; }
  tracker.requests += 1;
  const model = String(entry.model || fallbackModel || 'unknown');
  const row = tracker.models.get(model) || { model, requests: 0, inputTokens: 0, outputTokens: 0 };
  row.requests += 1;
  row.inputTokens += input;
  row.outputTokens += output;
  tracker.models.set(model, row);
}

export function trackFallback(tracker, event = {}) {
  if (!tracker || !event) return;
  tracker.fallbacks.push({ from: String(event.from || ''), to: String(event.to || ''), kind: String(event.kind || ''), reason: String(event.reason || '').slice(0, 200) });
}

export function buildRunReport(tracker, { result = {}, route = {}, escalation = null, now = Date.now() } = {}) {
  const allCalls = tracker.requests + tracker.sideRequests;
  const providerCostComplete = allCalls > 0 && tracker.providerCostRequests === allCalls;
  const verification = result.verification || {};
  const issues = Array.isArray(result.verificationIssues) ? result.verificationIssues : [];
  const outcome = result.finished
    ? (result.verificationIncomplete ? 'finished, not verified' : 'finished')
    : result.stoppedByLoopBreaker ? 'stopped: stuck'
      : result.limitReached ? 'stopped: step or tool-call limit'
        : result.stoppedByHook ? 'stopped by a hook'
          : 'stopped';
  return {
    outcome,
    verificationIssues: issues.slice(0, 5),
    lastCheck: verification.lastCheck || null,
    routing: route && route.enabled ? { mode: route.mode || 'classify', tier: route.tier, startModel: route.model, strongModel: route.strongModel, reason: route.reason } : null,
    escalation: escalation && escalation.done ? escalation.done : null,
    escalationSkipped: escalation && escalation.skipped ? escalation.skipped : '',
    fallbacks: tracker.fallbacks.slice(),
    models: [...tracker.models.values()],
    requests: tracker.requests,
    sideRequests: tracker.sideRequests,
    toolCalls: Number(result.toolCalls) || 0,
    tokens: { input: tracker.inputTokens, output: tracker.outputTokens, cacheRead: tracker.cacheReadTokens, cacheWrite: tracker.cacheCreationTokens, source: tracker.estimatedRequests ? tracker.estimatedRequests + ' of ' + allCalls + ' request(s) estimated from text length' : 'provider-reported' },
    cost: providerCostComplete
      ? { usd: tracker.providerCostUsd, source: 'provider-reported', estimateUsd: tracker.costKnown ? tracker.estimatedCostUsd : null }
      : { usd: tracker.costKnown ? tracker.estimatedCostUsd : null, source: tracker.costKnown ? 'estimate from the price table' : 'unknown (no price for at least one model)', ...(tracker.providerCostRequests ? { providerReportedPartUsd: tracker.providerCostUsd, providerReportedRequests: tracker.providerCostRequests } : {}) },
    durationMs: Math.max(0, now - tracker.started),
    scope: 'Requests made by this OASIS process. External CLIs, MCP servers and hooks that call models themselves are not included.'
  };
}

const n = (value) => Number(value || 0).toLocaleString('en-US');
const usd = (value) => '$' + (value < 0.01 && value > 0 ? value.toFixed(6) : value.toFixed(4));

export function formatRunReport(report) {
  if (!report) return 'No task has run in this session yet.';
  const lines = ['Last task: ' + report.outcome + ' in ' + (report.durationMs / 1000).toFixed(1) + ' s.'];
  if (report.verificationIssues.length) lines.push('  Not verified: ' + report.verificationIssues.join('; '));
  const models = report.models.map((row) => row.model + ' (' + n(row.requests) + ' request' + (row.requests === 1 ? '' : 's') + ')').join(', ');
  lines.push('Models: ' + (models || 'none'));
  if (report.routing) lines.push('  Routing (' + report.routing.mode + ', ' + report.routing.tier + '): ' + report.routing.reason);
  if (report.escalation) lines.push('  Escalated at step ' + report.escalation.step + ' from ' + report.escalation.from + ' to ' + report.escalation.to + ': ' + report.escalation.reason);
  else if (report.escalationSkipped) lines.push('  No escalation available: ' + report.escalationSkipped);
  for (const fallback of report.fallbacks) lines.push('  Fallback: ' + fallback.from + ' -> ' + fallback.to + (fallback.kind ? ' (' + fallback.kind + ')' : '') + (fallback.reason ? ': ' + fallback.reason : ''));
  lines.push('Requests: ' + n(report.requests) + ' model' + (report.sideRequests ? ' + ' + n(report.sideRequests) + ' side (compaction, advisor, subagents)' : '') + ' · tool calls: ' + n(report.toolCalls));
  lines.push('Tokens: ' + n(report.tokens.input) + ' input, ' + n(report.tokens.output) + ' output (' + report.tokens.source + ')' +
    (report.tokens.cacheRead ? ' · ' + n(report.tokens.cacheRead) + ' input tokens read from the prompt cache' + (report.tokens.input ? ' (' + Math.round(100 * report.tokens.cacheRead / report.tokens.input) + '%)' : '') : ''));
  const cost = report.cost;
  lines.push('Cost: ' + (cost.usd === null ? 'unknown' : usd(cost.usd)) + ' (' + cost.source + ')' +
    (cost.source === 'provider-reported' && typeof cost.estimateUsd === 'number' ? ' · price-table estimate ' + usd(cost.estimateUsd) : '') +
    (cost.providerReportedRequests ? ' · provider reported ' + usd(cost.providerReportedPartUsd) + ' for ' + n(cost.providerReportedRequests) + ' of the requests' : ''));
  lines.push(report.scope);
  return lines.join('\n');
}
