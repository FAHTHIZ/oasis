// Capability router (roadmap 2.3).
//
// Saved `oasis eval` reports, one per model, become a routing table: for each
// task class (the categories in evals/tasks/metadata.json) the cheapest model
// whose measured pass rate is at or above a quality floor and no more than
// `maxDrop` below the baseline model. The table is a pure function of the
// reports and the options, so a decision can be reproduced from the files.
// At run time, `modelRouting.mode: "capability"` sends a task to the model the
// table picked for its class. A task whose class is unclear uses the
// "overall" route (the same rule over the whole suite); tasks pinned by the
// safety rules in src/model-routing.mjs keep the strong model.
import { createHash } from 'node:crypto';
import { classifyDomains, classifyIntent } from './task-model.mjs';

export const TASK_CLASSES = [
  'agent-operations', 'configuration-integration', 'context-and-cost', 'data-structures',
  'input-validation', 'network-safety', 'secret-handling', 'security-boundaries', 'utility-logic',
  'data-analysis', 'writing', 'research-synthesis', 'planning', 'operations'
];

// Work that is not code is classed by the task model's domain, the same
// reading planning and verification use, rather than by a second keyword list.
const DOMAIN_CLASSES = { analysis: 'data-analysis', writing: 'writing', research: 'research-synthesis', planning: 'planning', operations: 'operations' };

// Ordered: the first class with the most hits wins, so the more specific
// (security and secrets) come first.
const CLASS_SIGNALS = {
  'security-boundaries': [/\b(?:path traversal|traversal|\.\.\/|archive entr(?:y|ies)|zip slip|symlink|outside (?:the )?(?:workspace|root|directory)|relative path|absolute path|escape)\b/i],
  'secret-handling': [/\b(?:secrets?|api[ -]?keys?|tokens? (?:in|from) (?:logs?|env)|credentials?|redact(?:ion|s|ed)?|scrub|sensitive (?:path|file|value)s?|password|\.env\b|private key)/i],
  'network-safety': [/\b(?:urls?|redirects?|loopback|localhost|same.origin|hosts?names?|https?|endpoints?|response bod(?:y|ies)|body limit|ssrf|ip address)\b/i],
  'context-and-cost': [/\b(?:tokens?|token usage|context (?:window|size|length)|cost|price|pricing|usd|session history|truncat(?:e|ion) (?:of )?history|estimate)\b/i],
  'configuration-integration': [/\b(?:config(?:uration)?|settings?|mcp servers?|provider setup|persist(?:s|ed|ing)?|max_?output_?tokens|options? file|json file)\b/i],
  'agent-operations': [/\b(?:retr(?:y|ies)|backoff|budgets?|tool batch|tool calls?|undo|recurring|emitter|unsubscribe|listeners?|transient|rate limit)\b/i],
  'data-structures': [/\b(?:cache|ttl|pagination|page count|paginate|glob|sort(?:ed|ing)?|search|dependenc(?:y|ies)|ids? reuse|copies|copy of|map|set|queue|priority)\b/i],
  'input-validation': [/\b(?:pars(?:e|es|ing)|validat(?:e|es|ion|ing)|normali[sz](?:e|es|ation)|strict|malformed|invalid|untrusted|flags?|csv|headers?|booleans?|integer|bounds)\b/i],
  'utility-logic': [/\b(?:clamp|dedupe|duplicates?|slice|lines?|truncate|emoji|overdue|helper|format|text)\b/i]
};

/**
 * The eval task class a prompt belongs to, or '' when unsure. A class is
 * named only when it has at least two signal hits and beats the runner-up by
 * at least two, so an unclear task falls back to the "overall" route.
 */
export function classifyTaskClass(prompt, { detail = false } = {}) {
  const text = String(prompt || '').slice(0, 8000);
  const domains = classifyDomains(text, { intent: classifyIntent(text) });
  const domainClass = DOMAIN_CLASSES[domains.primary];
  if (domainClass) {
    const lead = domains.scores[domains.primary] || 0;
    const code = Math.max(domains.scores.software || 0, domains.scores.security || 0);
    // Named only when code is absent or far behind: "write a function" is code.
    if ((lead >= 2 && code * 2 <= lead) || (lead >= 1 && code === 0)) {
      return detail ? { name: domainClass, best: domainClass, score: lead, margin: lead - code, via: 'domain' } : domainClass;
    }
  }
  const scores = Object.entries(CLASS_SIGNALS).map(([name, patterns]) => {
    let score = 0;
    for (const pattern of patterns) score += (text.match(new RegExp(pattern.source, pattern.flags + 'g')) || []).length;
    return { name, score };
  }).sort((a, b) => b.score - a.score);
  const [first, second] = scores;
  const confident = first.score >= 2 && first.score - (second ? second.score : 0) >= 2;
  const name = confident ? first.name : '';
  return detail ? { name, best: first.name, score: first.score, margin: first.score - (second ? second.score : 0) } : name;
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

/**
 * Builds the routing table. `runs` are parsed reports:
 * [{ label, model?, results: [{ taskId, passed, category, costUSD }] }].
 * Options: floor (0-1, default 0.8), maxDrop (0-1, default 0.02), baseline
 * (a run label; default the run with the best overall pass rate).
 */
export function buildRoutingTable(runs, { floor = 0.8, maxDrop = 0.02, baseline = '' } = {}) {
  if (!Array.isArray(runs) || runs.length < 2) throw new Error('A routing table needs reports from at least two models.');
  const labels = runs.map((run) => String(run.label || '').trim());
  if (labels.some((label) => !label) || new Set(labels).size !== labels.length) throw new Error('Every report needs a distinct label (or provider.model).');
  const qualityFloor = Number(floor);
  const drop = Number(maxDrop);
  if (!(qualityFloor >= 0 && qualityFloor <= 1)) throw new Error('--floor must be between 0 and 1.');
  if (!(drop >= 0 && drop <= 1)) throw new Error('--max-drop must be between 0 and 1.');

  const stats = new Map(); // label -> class -> { trials, passed, cost, costKnown }
  for (const run of runs) {
    const perClass = new Map();
    for (const row of run.results || []) {
      const name = TASK_CLASSES.includes(row.category) ? row.category : null;
      if (!name) continue;
      const entry = perClass.get(name) || { trials: 0, passed: 0, cost: 0, costKnown: true };
      entry.trials++;
      if (row.passed) entry.passed++;
      if (Number.isFinite(row.costUSD) && row.costUSD !== null) entry.cost += row.costUSD; else entry.costKnown = false;
      perClass.set(name, entry);
    }
    stats.set(String(run.label), perClass);
  }
  const overall = (label) => {
    let trials = 0; let passed = 0;
    for (const entry of stats.get(label).values()) { trials += entry.trials; passed += entry.passed; }
    return trials ? passed / trials : 0;
  };
  const baselineLabel = baseline ? String(baseline) : [...labels].sort((a, b) => overall(b) - overall(a) || a.localeCompare(b))[0];
  if (!stats.has(baselineLabel)) throw new Error('Baseline ' + baselineLabel + ' is not one of the report labels: ' + labels.join(', ') + '.');

  const classes = {};
  const allClasses = (label) => {
    const sum = { trials: 0, passed: 0, cost: 0, costKnown: true };
    for (const entry of stats.get(label).values()) { sum.trials += entry.trials; sum.passed += entry.passed; sum.cost += entry.cost; sum.costKnown &&= entry.costKnown; }
    return sum;
  };
  // "overall" covers tasks whose class is unclear: the whole suite at once.
  for (const name of [...TASK_CLASSES, 'overall']) {
    const candidates = [];
    for (const label of labels) {
      const entry = name === 'overall' ? allClasses(label) : stats.get(label).get(name);
      if (!entry || !entry.trials) continue;
      candidates.push({ model: modelOf(runs, label), label, trials: entry.trials, passRate: round(entry.passed / entry.trials, 4), meanCostUSD: entry.costKnown ? round(entry.cost / entry.trials, 9) : null });
    }
    const base = candidates.find((item) => item.label === baselineLabel);
    if (!base) continue;
    const eligible = candidates.filter((item) => item.passRate >= qualityFloor && item.passRate >= base.passRate - drop - 1e-9);
    // Cheapest known cost first; unknown cost is never assumed cheap.
    eligible.sort((a, b) => (a.meanCostUSD ?? Infinity) - (b.meanCostUSD ?? Infinity) || b.passRate - a.passRate || a.label.localeCompare(b.label));
    const pick = eligible[0] || base;
    classes[name] = {
      model: pick.model,
      label: pick.label,
      passRate: pick.passRate,
      meanCostUSD: pick.meanCostUSD,
      baselinePassRate: base.passRate,
      reason: eligible.length ? 'cheapest model at or above the floor and within ' + round(drop * 100, 2) + ' points of ' + baselineLabel : 'no model met the floor; kept ' + baselineLabel,
      candidates
    };
  }
  const table = { schemaVersion: 1, floor: qualityFloor, maxDrop: drop, baseline: baselineLabel, baselineModel: modelOf(runs, baselineLabel), classes };
  table.digest = createHash('sha256').update(stable({ ...table, digest: undefined })).digest('hex');
  return table;
}

function modelOf(runs, label) {
  const run = runs.find((item) => String(item.label) === label);
  return String((run && run.model) || label).slice(0, 200);
}

/** Settings routes ({ class: model }) from a table. */
export function routesFromTable(table) {
  const routes = {};
  for (const [name, entry] of Object.entries((table && table.classes) || {})) if ((TASK_CLASSES.includes(name) || name === 'overall') && entry && entry.model) routes[name] = String(entry.model).slice(0, 200);
  return routes;
}

/** Keeps only known classes and plain model ids. */
export function sanitizeRoutes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const name of [...TASK_CLASSES, 'overall']) {
    const model = value[name];
    if (typeof model === 'string' && model.trim()) out[name] = model.trim().replace(/[\r\n\0]/g, '').slice(0, 200);
  }
  return out;
}
