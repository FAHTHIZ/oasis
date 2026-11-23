// The task model: one record shared by planning, execution, delegation,
// permissions, verification, memory and completion.
//
// Before this module, "a task" meant something different in every part of
// the runtime: a shared-task board entry (subject, description, deps), a
// subagent record (prompt, type, status), a /goal condition, a plan-mode
// plan, a checklist. None of them said what the work was supposed to
// produce or how anyone would know it had. Three separate classifiers
// (src/task-classifier.mjs for routing, src/capability-router.mjs for eval
// classes, taskDomain in src/agent-experience.mjs) guessed at the kind of
// work, each with its own vocabulary.
//
// A TaskSpec says, for one piece of work:
//
//   intent        what is being asked: question, change, create, investigate,
//                 operate or plan, and a one-line summary
//   domains       primary and secondary domain (software, security, research,
//                 analysis, writing, planning, automation, computer,
//                 operations, general)
//   deliverables  what should exist at the end: an answer, a file, a code
//                 change, a report, a dataset, a plan, an external action
//   constraints   what must not happen or must hold (word limits, "do not
//                 touch X", "only Y"); measurable ones become criteria
//   acceptance    criteria the runtime itself can check against the evidence
//                 ledger and the workspace, plus ones it cannot (`manual`)
//   dependencies  other task ids that must finish first
//   risk          level and reasons (destructive, external side effects,
//                 publishing, money, credentials, production)
//   permissions   the kinds of access the work needs; enforcement stays in
//                 src/permissions.mjs, this is what verification and the
//                 autonomy level read
//   evidence      what kinds of evidence a supported result needs
//   autonomy      how much planning, delegation and verification the task
//                 deserves: simple work stays simple
//   outcome       filled in by assessOutcome: execution, evidence, claims,
//                 acceptance and independent verification as separate
//                 results, and a verdict derived from them
//
// Three concerns stay apart on purpose:
//
//   safety        permission modes, shell-risk analysis, protected paths and
//                 sandboxes (unchanged, never loosened by anything here)
//   quality       domain verifiers: does the result meet its criteria
//   outcome       what is recorded as having happened, which routing,
//                 experience and memory learn from
//
// Intake is deterministic and model-free, so it costs nothing on a simple
// question and can be tested exhaustively. The model can add deliverables
// and criteria (task_contract declare), but it can never mark a criterion as
// met: only the runtime's own evaluation does.

import { multilingualRisk, multilingualIntent } from './multilingual-signals.mjs';
import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { assessReport } from './verification-contracts.mjs';
import { buildClaims } from './claim-ledger.mjs';
import { digestOf, fetchedUrls } from './evidence-ledger.mjs';
import { independentSources } from './source-independence.mjs';
import { combinedReview } from './task-reviews.mjs';

export const TASK_SCHEMA_VERSION = 1;
export const DOMAINS = Object.freeze(['software', 'security', 'research', 'analysis', 'writing', 'planning', 'automation', 'computer', 'operations', 'general']);
export const INTENTS = Object.freeze(['question', 'change', 'create', 'investigate', 'operate', 'plan']);
export const RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);
export const CRITERION_KINDS = Object.freeze(['check_passes', 'file_exists', 'word_limit', 'cites_sources', 'claims_supported', 'side_effect', 'independent_review', 'manual']);
export const VERDICTS = Object.freeze(['failed', 'cancelled', 'incomplete', 'rejected', 'unverified', 'evidenced', 'verified', 'independently_verified']);

// Domain signals. Each pattern counts its matches; the highest score wins.
// Weights > 1 mark a strong signal (a file extension is stronger than "build").
const DOMAIN_SIGNALS = {
  security: [
    [/\b(?:vulnerab\w*|exploit\w*|cve-\d{4}-\d+|xss|csrf|sql injection|injection attack|threat model\w*|pentest\w*|penetration test\w*|security (?:review|audit|scan|issue|hole|bug)s?|attack surface|sandbox escape|privilege escalation|secrets? (?:leak|scan)\w*|malware|phishing|hardening|ssrf|rce)\b/gi, 2],
    [/\b(?:auth(?:entication|orization)|permissions?|credentials?|encrypt\w*|tls|certificates?|firewall)\b/gi, 1]
  ],
  software: [
    [/\b\w+\.(?:m?js|cjs|tsx?|jsx|py|go|rs|java|kt|swift|rb|php|cs|cpp|cc|c|h|hpp|vue|svelte|scala|sql|sh)\b/gi, 2],
    [/\b(?:bug|refactor\w*|unit tests?|test suite|failing tests?|compile[sdr]?|stack trace|regression|lint\w*|type-?check\w*|function|class|method|module|endpoint|api|repo(?:sitory)?|codebase|pull request|commit|merge conflict|dependency|npm|pip|cargo|typescript|javascript|python|golang|rust)\b/gi, 1],
    [/\b(?:implement|debug|fix|patch)\b/gi, 1],
    // A named function call (`loadMcpServers()`) or a request for tests is code work.
    [/\b[A-Za-z_$][\w$]*\(\)/g, 2],
    [/\b(?:add|write|update|extend)\s+(?:\w+\s+){0,2}tests?\b/gi, 1],
    [/\b(?:(?:run|rerun|re-run) (?:the |all |my |our )?(?:tests?|specs?|build|linter|type ?checks?|test suite)|tests? (?:pass|fail)\w*)\b/gi, 2]
  ],
  research: [
    [/\b(?:research|literature|sources?|citations?|cit(?:e|es|ed|ing)|fact-?check\w*|look up|find out|investigate|survey|news|latest|according to|evidence for|papers?|studies|study|reports? on|who (?:is|was|are)|when (?:did|was|is))\b/gi, 1],
    [/\b(?:compare|comparison|versus|vs\.?|pros and cons|review of)\b/gi, 1]
  ],
  analysis: [
    [/\b\w+\.(?:csv|tsv|xlsx?|parquet|jsonl|ipynb)\b/gi, 2],
    [/\b(?:analy[sz]e|analysis|datasets?|data|statistic\w*|regression analysis|correlat\w*|averages?|mean|median|percentiles?|charts?|plots?|graphs?|calculate|compute|metrics?|forecast\w*|trend\w*|kpis?|pivot|aggregate\w*|distribution)\b/gi, 1]
  ],
  writing: [
    [/\b(?:write|draft|rewrite|edit|proofread|summari[sz]e|summary|translate|essay|article|blog(?: post)?|email|letter|memo|cover letter|press release|announcement|copy(?:writing)?|story|poem|speech|outline|newsletter|readme|documentation|docs|tone|wording)\b/gi, 1],
    [/\b(?:words?|paragraphs?|sentences?|bullet points?)\b/gi, 1]
  ],
  planning: [
    [/\b(?:plan|roadmap|strategy|strategic|milestones?|timeline|schedule|itinerary|prioriti[sz]e|trade-?offs?|decision|decide|options|road ?map|okrs?|budget(?:ing)?|project plan|break (?:it|this) down|steps to)\b/gi, 1]
  ],
  automation: [
    [/\b(?:automate|automation|every (?:day|week|hour|morning|night|monday|month)|recurring|cron|schedule[ds]? (?:a|the)? ?(?:job|task|run)|workflow|pipeline|webhook|trigger|bot|routine)\b/gi, 1]
  ],
  computer: [
    [/\b(?:click|screenshot|desktop|screen|window|gui|browser|web ?page|fill (?:in|out)|log ?in to|sign in to|navigate to|open the app|form|tab)\b/gi, 1]
  ],
  operations: [
    [/\b(?:deploy\w*|install\w*|configure|configuration|docker|container|kubernetes|k8s|server|nginx|systemd|ci|cd|backup|restore|migrate|migration|provision\w*|monitoring|incident|outage|uptime|dns|ssl|infrastructure|terraform|ansible)\b/gi, 1]
  ]
};

const INTENT_SIGNALS = {
  plan: /\b(?:plan|roadmap|strategy|how should (?:i|we)|what should (?:i|we)|break (?:it|this) down|steps to|itinerary|prioriti[sz]e)\b/i,
  operate: /\b(?:deploy|install|run|execute|send|post|publish|schedule|book|buy|purchase|pay|transfer|restart|start|stop|launch|release|merge|push|upload|download|delete|remove|clean up|migrate|open|log ?in|sign ?in|click|fill (?:in|out)|submit|navigate|automate|back ?up)\b/i,
  change: /\b(?:fix|update|modify|change|edit|refactor|rename|move|upgrade|improve|optimi[sz]e|rewrite|repair|patch|correct|adjust|tweak|convert|port)\b/i,
  create: /\b(?:write|draft|create|build|make|generate|produce|implement|add|design|compose|prepare|set up)\b/i,
  investigate: /\b(?:research|investigate|find out|look into|look up|diagnose|audit|review|analy[sz]e|compare|evaluate|assess|check whether|verify|fact-?check|figure out|why does|why is|root cause)\b/i
};

const QUESTION = /^(?:what|why|how|when|where|who|which|whose|is|are|was|were|do|does|did|can|could|should|would|will|explain|describe|define|tell me)\b|\?\s*$/i;

// Risk: what could go wrong if this is done wrongly, and whether it can be undone.
const RISK_SIGNALS = [
  { id: 'destructive', level: 'high', permission: 'destructive', pattern: /\b(?:delete|remove|wipe|erase|drop (?:the )?(?:table|database|schema)|truncate|rm -rf|force[- ]push|reset --hard|purge|destroy|overwrite)\b/i },
  { id: 'financial', level: 'critical', permission: 'financial', pattern: /\b(?:pay(?:ing)? (?:for|the|an?|my|our|\$)|make (?:a |the )?payments?|purchase|buy(?:ing)? (?!time\b)|checkout|transfer (?:money|funds|\$|\d)|wire (?:money|funds|\$|\d)|issue (?:a )?refund|place (?:an? |the )?order|order (?:a|an|the|some|me)\s+(?!of\b)|charge (?:the|my|their) (?:card|account|customer)|sell (?:my |our |the )?(?:shares|stocks?|crypto)|subscribe (?:to|for) (?:a |the )?(?:paid|premium|pro)\b)/i },
  { id: 'external_communication', level: 'high', permission: 'external-communication', pattern: /\b(?:send (?:an? |the |this |that |my |our )?(?:e-?mails?|messages?|texts?|sms|dms?|invites?|invitations?|repl(?:y|ies)|newsletter)|e-?mail (?:it|them|this|the|my|our|everyone|\w+@)|(?:post|share|publish) (?:\w+ ){0,3}(?:to|on) (?:twitter|x|slack|linkedin|facebook|reddit|discord|mastodon|bluesky|social media|the (?:team|channel|group))|tweet|reply to (?:the )?(?:customer|client|thread|email|message)|notify (?:the )?(?:team|users|customers|everyone)|message (?:the )?(?:team|channel|group|customer))\b/i },
  { id: 'publishing', level: 'high', permission: 'publish', pattern: /\b(?:publish|release|deploy|ship (?:it|to)|go live|push to (?:main|master|prod\w*|origin)|git push|npm publish|merge (?:the )?(?:pr|pull request)|tag (?:a )?release)\b/i },
  { id: 'production', level: 'high', permission: 'production', pattern: /\b(?:production|prod (?:server|database|db|environment)|live (?:site|server|database|system)|customers?' data)\b/i },
  { id: 'credentials', level: 'medium', permission: 'credentials', pattern: /\b(?:api[ -]?keys?|passwords?|secrets?|(?:access|auth|bearer|api|refresh|session|github|oauth)[ -]?tokens?|credentials?|private keys?|ssh keys?|\.env)\b/i },
  { id: 'system_change', level: 'medium', permission: 'execute', pattern: /\b(?:install|uninstall|configure|sudo|chmod|chown|systemctl|crontab|registry|firewall|iptables)\b/i }
];
const RISK_RANK = { low: 0, medium: 1, high: 2, critical: 3 };
const NEGATED_RISK = /\b(?:do not|don't|never|without|avoid|no)\s+(?:\w+\s+){0,3}$/i;

const FILE_TARGET = /(?:\b(to|into|as|named|called|save(?:d)?(?: it)?(?: as| to)?|create|write|output|produce|generate|export(?:ed)?(?: to)?)\s+)[`"']?((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.(?:md|markdown|txt|csv|tsv|json|jsonl|ya?ml|html?|pdf|docx|xlsx|pptx|png|svg|jpg|jpeg|py|m?js|ts|tsx|sh|sql|ipynb|xml|toml|ini|rst|tex))\b[`"']?/gi;
// "run the tests", "rerun the build": the deliverable is a check and its result.
const RUNS_CHECK = /\b(?:run|rerun|re-run|execute)\b[^.?!\n]{0,40}\b(?:tests?|specs?|test suite|build|lint\w*|type ?checks?|checks?)\b/i;
// Actions with effects outside the conversation that tool results record.
const EFFECT = /\b(?:deploy|install|send|post|publish|book|buy|purchase|pay|transfer|merge|push|upload|download|delete|remove|migrate|submit|back ?up|release|commit|tag)\b/i;
const CONTINUATION = /^(?:(?:ok(?:ay)?|yes|yep|yeah|sure|go(?: ahead| on)?|continue|keep going|proceed|do it|please do|carry on|next|again|retry|try again|go for it|sounds good|looks good|lgtm|thanks?|thank you)[\s.!,]*)+$/i;

function clean(value, max) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function stripContext(text) {
  // Attached file bodies, fenced code and quoted pasted material say little
  // about what is being asked; they would swamp the signals.
  return String(text || '')
    .replace(/<(file|directory|session-context|repo-map|system-reminder|mcp-resource[^>]*)\b[^>]*>[\s\S]*?<\/\1>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .slice(0, 12000);
}

/**
 * Domain scores for a request: { primary, secondary, scores }. `secondary`
 * holds other domains scoring at least half the leader. 'general' when no
 * signal stands out.
 */
const INTENT_BIAS = { investigate: ['research', 'security', 'analysis'], operate: ['operations', 'automation', 'computer'], plan: ['planning'] };

export function classifyDomains(text, { intent = '' } = {}) {
  const value = stripContext(text);
  const scores = {};
  for (const [domain, signals] of Object.entries(DOMAIN_SIGNALS)) {
    let score = 0;
    for (const [pattern, weight] of signals) score += ((value.match(pattern) || []).length) * weight;
    if (score) scores[domain] = score;
  }
  // The kind of request breaks ties between domains it already mentions:
  // "research X and write a summary" is research first.
  for (const domain of INTENT_BIAS[intent] || []) if (scores[domain]) scores[domain] += 1;
  // Security work is software work with a sharper bar; it wins ties with software.
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1] || order(a[0]) - order(b[0]));
  if (!ranked.length) return { primary: 'general', secondary: [], scores };
  const [top, topScore] = ranked[0];
  const secondary = ranked.slice(1).filter(([, score]) => score * 2 >= topScore).map(([name]) => name).slice(0, 3);
  return { primary: top, secondary, scores };
}
function order(domain) { return DOMAINS.indexOf(domain); }

/** The single domain name used by track records and routing. */
export function primaryDomain(text) { return classifyDomains(text).primary; }

// Old experience rows used a coarser vocabulary; map them to today's names.
const LEGACY_DOMAINS = { code: 'software', ops: 'operations', review: 'software' };
export function normalizeDomain(domain) {
  const value = String(domain || '').toLowerCase();
  if (DOMAINS.includes(value)) return value;
  return LEGACY_DOMAINS[value] || 'general';
}

export function classifyIntent(text) {
  const value = stripContext(text).trim();
  const head = value.split(/(?<=[.!?])\s+|\n/)[0] || value;
  // The first sentence states the request; later ones add detail.
  for (const kind of ['plan', 'investigate', 'operate', 'change', 'create']) {
    if (INTENT_SIGNALS[kind].test(head)) {
      // "How do I deploy?" asks for knowledge, not an action.
      if ((kind === 'operate' || kind === 'change' || kind === 'create') && QUESTION.test(head) && !/^(?:can|could|would|will) you\b/i.test(head)) return 'question';
      return kind;
    }
  }
  if (QUESTION.test(head)) return 'question';
  for (const kind of ['investigate', 'operate', 'change', 'create', 'plan']) if (INTENT_SIGNALS[kind].test(value)) return kind;
  // No English signal: read the request in the language it was written in.
  return multilingualIntent(value) || 'question';
}

/** Risk level, reasons and the permission kinds they need. Negated mentions ("do not delete") are ignored. */
export function assessRisk(text) {
  const value = stripContext(text);
  const reasons = [];
  const permissions = new Set();
  let level = 'low';
  for (const signal of RISK_SIGNALS) {
    const global = new RegExp(signal.pattern.source, signal.pattern.flags.includes('g') ? signal.pattern.flags : signal.pattern.flags + 'g');
    let hit = false;
    for (const match of value.matchAll(global)) {
      const before = value.slice(Math.max(0, match.index - 40), match.index);
      if (NEGATED_RISK.test(before)) continue;
      hit = true;
      break;
    }
    if (!hit) continue;
    reasons.push(signal.id);
    permissions.add(signal.permission);
    if (RISK_RANK[signal.level] > RISK_RANK[level]) level = signal.level;
  }
  // The same risks stated in other languages (src/multilingual-signals.mjs).
  for (const signal of multilingualRisk(value)) {
    if (!reasons.includes(signal.id)) reasons.push(signal.id);
    permissions.add(signal.permission);
    if (RISK_RANK[signal.level] > RISK_RANK[level]) level = signal.level;
  }
  return { level, reasons, permissions: [...permissions] };
}

/** File paths the request asks to produce ("save it to report.md"). */
export function targetFiles(text) {
  const out = [];
  const value = stripContext(text);
  for (const match of value.matchAll(FILE_TARGET)) {
    // "to", "into" and "as" name an output only after a verb that produces
    // one ("save the summary to notes.md"), not in "move the helper to utils.js".
    if (/^(?:to|into|as)$/i.test(match[1]) && !/\b(?:save|write|export|output|put|store|dump|print|render|draft|summari[sz]e|generate|produce|create|compile|convert|download)\w*\b[^.!?\n]{0,80}$/i.test(value.slice(Math.max(0, match.index - 100), match.index))) continue;
    const file = match[2].replace(/^\.\//, '');
    if (/^https?:/i.test(file) || file.includes('..')) continue;
    if (!out.includes(file)) out.push(file);
    if (out.length >= 8) break;
  }
  return out;
}

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20, fifty: 50, hundred: 100 };
function numberOf(raw) {
  const value = String(raw || '').toLowerCase().replace(/,/g, '');
  return NUMBER_WORDS[value] ?? (Number.isFinite(Number(value)) ? Number(value) : NaN);
}

/** Measurable length limits: { max?, min?, unit } for words, sentences, bullets or paragraphs. */
export function lengthLimits(text) {
  const value = stripContext(text);
  const limits = [];
  const unit = '(words?|sentences?|bullet(?: points?)?|bullets|paragraphs?|lines?|characters?)';
  const num = '(\\d[\\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|fifty|hundred)';
  const push = (kind, n, u) => {
    const count = numberOf(n);
    if (!Number.isFinite(count) || count <= 0 || count > 100000) return;
    const name = u.toLowerCase().replace(/s$/, '').replace(/^bullet(?: point)?$/, 'bullet').replace(/^bullet point$/, 'bullet');
    const unitName = name.startsWith('bullet') ? 'bullet' : name;
    const existing = limits.find((item) => item.unit === unitName);
    if (existing) { existing[kind] = count; return; }
    limits.push({ unit: unitName, [kind]: count });
  };
  for (const match of value.matchAll(new RegExp('\\b(?:under|fewer than|less than|at most|no more than|max(?:imum)?(?: of)?|up to|within|not exceed(?:ing)?|maximum|no longer than|not longer than|shorter than)\\s+' + num + '\\s+' + unit, 'gi'))) push('max', match[1], match[2]);
  for (const match of value.matchAll(new RegExp('\\b(?:at least|minimum(?: of)?|no fewer than|more than|over)\\s+' + num + '\\s+' + unit, 'gi'))) push('min', match[1], match[2]);
  for (const match of value.matchAll(new RegExp('\\b(?:exactly|in|using)\\s+' + num + '\\s+(words?|sentences?|bullet(?: points?)?|bullets|paragraphs?)\\b', 'gi'))) { push('min', match[1], match[2]); push('max', match[1], match[2]); }
  for (const match of value.matchAll(new RegExp('\\b' + num + '[- ]' + unit + '\\s+(?:summary|essay|article|post|email|bio|description|abstract|answer|reply|overview|report|list|story|letter|intro(?:duction)?|paragraph)', 'gi'))) {
    // "a 300-word summary": allow 20% either way, a common editorial reading.
    const n = numberOf(match[1]);
    if (!Number.isFinite(n)) continue;
    const u = match[2].toLowerCase();
    // "a two-sentence summary" is a ceiling in practice: one good sentence
    // is not a miss.
    if (/^word/.test(u)) { push('min', String(Math.floor(n * 0.8)), u); push('max', String(Math.ceil(n * 1.2)), u); }
    else push('max', match[1], u);
  }
  return limits;
}

/** Constraint sentences: prohibitions and restrictions, as written. */
export function constraintsIn(text) {
  const value = stripContext(text);
  const out = [];
  for (const sentence of value.split(/(?<=[.!?;])\s+|\n+/)) {
    const s = sentence.trim();
    if (!s || s.length > 300) continue;
    if (/\b(?:do not|don't|never|must not|mustn't|should not|shouldn't|without|avoid|only|no more than|at most|under \d|keep it|stay within|limit(?:ed)? to|except|excluding|leave .{1,40} (?:alone|untouched|as is))\b/i.test(s)) out.push(clean(s, 240));
    if (out.length >= 10) break;
  }
  return out;
}

const DELIVERABLE_SIGNALS = [
  ['plan', /\b(?:plan|roadmap|itinerary|schedule|timeline|checklist|steps)\b/i],
  ['report', /\b(?:report|brief(?:ing)?|memo|write-?up|summary|overview|analysis|comparison|review)\b/i],
  ['dataset', /\b(?:table|spreadsheet|dataset|csv|chart|graph|plot|dashboard)\b/i],
  ['document', /\b(?:essay|article|blog post|email|letter|post|story|poem|speech|documentation|readme|press release|cover letter|newsletter|proposal)\b/i]
];

function deliverablesFor(text, intent, domains, files) {
  const value = stripContext(text);
  const out = [];
  for (const file of files) out.push({ id: 'd' + (out.length + 1), kind: 'file', description: 'File ' + file, path: file });
  if ((intent === 'change' || intent === 'create') && (domains.primary === 'software' || domains.primary === 'security') && !files.length) {
    out.push({ id: 'd' + (out.length + 1), kind: 'code_change', description: 'A working change to the workspace' });
  }
  if (intent === 'operate' && RUNS_CHECK.test(value)) out.push({ id: 'd' + (out.length + 1), kind: 'check', description: 'The check, run, and its result reported' });
  else if (intent === 'operate') out.push({ id: 'd' + (out.length + 1), kind: 'action', description: 'The requested action, carried out', ...(EFFECT.test(value) ? { effect: true } : {}) });
  for (const [kind, pattern] of DELIVERABLE_SIGNALS) {
    if (out.length >= 6) break;
    if (pattern.test(value) && !out.some((item) => item.kind === kind)) out.push({ id: 'd' + (out.length + 1), kind, description: kind === 'plan' ? 'A plan' : kind === 'report' ? 'A written report' : kind === 'dataset' ? 'Data, a table or a chart' : 'A written document' });
  }
  if (!out.length) out.push({ id: 'd1', kind: 'answer', description: 'An answer to the request' });
  return out;
}

function complexityOf(text, { intent, domains, deliverables, risk, constraints }) {
  const value = stripContext(text);
  const words = value.split(/\s+/).filter(Boolean).length;
  let score = 0;
  if (words > 40) score += 1;
  if (words > 150) score += 1;
  if (words > 400) score += 1;
  if (/\b(?:first|then|after that|finally|step \d|phase|and also|as well as|end[- ]to[- ]end|entire|whole|full|complete|every|all of)\b/i.test(value)) score += 1;
  if ((value.match(/^\s*(?:[-*•]|\d+[.)])\s+/gm) || []).length >= 3) score += 1;
  if (domains.secondary.length) score += 1;
  if (deliverables.filter((item) => item.kind !== 'answer').length >= 2) score += 1;
  if (RISK_RANK[risk.level] >= 2) score += 1;
  if (constraints.length >= 3) score += 1;
  if (/\b(?:this|the|entire|whole|our|my) (?:repo|repository|codebase|project|application|app|system|website|site)\b/i.test(value) && intent !== 'question') score += 1;
  if (intent === 'question' && words <= 25 && !domains.secondary.length) score = Math.min(score, 0);
  // Changing, creating or acting on something is never trivial: it needs at least a runtime check.
  if (intent !== 'question' && score < 1) score = 1;
  return score <= 0 ? 'trivial' : score <= 1 ? 'simple' : score <= 3 ? 'moderate' : 'complex';
}

/**
 * How much process the task deserves. Simple tasks stay simple: no plan, no
 * delegation, runtime checks only. Independent verification is asked for
 * when the work is complex or risky, never by default.
 */
export function autonomyFor({ complexity, risk, intent }) {
  const high = RISK_RANK[risk.level] >= 2;
  return {
    planning: complexity === 'complex' || (complexity === 'moderate' && intent !== 'question') ? 'explicit' : complexity === 'moderate' ? 'light' : 'none',
    delegation: complexity === 'complex' ? 'recommended' : complexity === 'moderate' ? 'optional' : 'none',
    verification: complexity === 'complex' || high ? 'independent' : complexity === 'trivial' && !high ? 'none' : 'runtime',
    // Irreversible or external actions are confirmed by the permission
    // system; the spec only records that they are expected.
    confirm: risk.reasons.filter((reason) => ['destructive', 'financial', 'external_communication', 'publishing', 'production'].includes(reason))
  };
}

function evidenceFor({ intent, domains, deliverables }) {
  const need = new Set();
  const all = [domains.primary, ...domains.secondary];
  if ((all.includes('software') || all.includes('security')) && (intent === 'change' || intent === 'create' || deliverables.some((item) => item.kind === 'check'))) need.add('check');
  if (all.includes('research') || intent === 'investigate') need.add('fetch');
  if (all.includes('analysis')) need.add('execution');
  if (deliverables.some((item) => item.kind === 'file')) need.add('file');
  // Only actions that leave a mark the runtime records (a commit, an install,
  // a message sent, a merge) can be checked; opening a page or running a
  // command is not one.
  if (deliverables.some((item) => item.kind === 'action' && item.effect)) need.add('side_effect');
  return [...need];
}

function criteriaFor(text, { intent, domains, deliverables, evidence }) {
  const out = [];
  const add = (kind, description, params = {}) => out.push({ id: 'c' + (out.length + 1), kind, description: clean(description, 240), params, source: 'derived', status: 'open', evidence: [] });
  for (const item of deliverables) if (item.kind === 'file') add('file_exists', item.path + ' exists and is not empty', { path: item.path });
  const file = deliverables.find((item) => item.kind === 'file' && /\.(?:md|markdown|txt|html?|rst)$/i.test(item.path));
  for (const limit of lengthLimits(text)) {
    const parts = [];
    if (limit.min !== undefined) parts.push('at least ' + limit.min);
    if (limit.max !== undefined) parts.push('at most ' + limit.max);
    add('word_limit', (file ? file.path : 'The reply') + ': ' + parts.join(' and ') + ' ' + limit.unit + 's', { unit: limit.unit, ...(limit.min !== undefined ? { min: limit.min } : {}), ...(limit.max !== undefined ? { max: limit.max } : {}), target: file ? file.path : 'reply' });
  }
  if (evidence.includes('check')) add('check_passes', 'A relevant test, build or check passes after the last edit');
  const all = [domains.primary, ...domains.secondary];
  if (all.includes('research') && /\b(?:sources?|cit(?:e|es|ed|ing)|citations?|references?|links?|evidence|fact-?check|verify)\b/i.test(stripContext(text))) {
    const many = /\b(?:multiple|several|independent|at least (?:two|2|three|3)|cross-?check|corroborat\w*)\b/i.test(stripContext(text));
    add('cites_sources', 'Claims cite pages that were actually read' + (many ? ', from at least two independent sources' : ''), { min: many ? 2 : 1, independent: many });
  }
  if (all.includes('research') || all.includes('analysis') || intent === 'investigate') add('claims_supported', 'Every citation, quote and computed number in the result is backed by evidence the runtime observed');
  if (evidence.includes('side_effect')) add('side_effect', 'The requested action shows up in a tool result, not only in the reply');
  return out;
}

let nextId = 1;

/**
 * Derives a TaskSpec from a request. Deterministic; no model call.
 * Options: { source, parentId, previous, mode, id }. A continuation ("yes",
 * "go on") of a previous spec keeps that spec (with a new turn) instead of
 * starting a new one.
 */
export function deriveTaskSpec(request, { source = 'user', parentId = '', previous = null, mode = '', id = '', now = Date.now() } = {}) {
  const text = String(request || '');
  const trimmed = stripContext(text).trim();
  const digest = digestOf(trimmed);
  if (previous && previous.schemaVersion === TASK_SCHEMA_VERSION) {
    // The same request again (a retry after a provider error) is the same task.
    if (previous.digest && previous.digest === digest) return { ...previous, updatedAt: now, outcome: null };
    if (CONTINUATION.test(trimmed)) return { ...previous, turns: (previous.turns || 1) + 1, updatedAt: now, outcome: null };
  }
  const intent = classifyIntent(text);
  const domains = classifyDomains(text, { intent });
  const risk = assessRisk(text);
  const files = targetFiles(text);
  const deliverables = deliverablesFor(text, intent, domains, files);
  const constraints = constraintsIn(text);
  const complexity = complexityOf(text, { intent, domains, deliverables, risk, constraints });
  const evidence = evidenceFor({ intent, domains, deliverables });
  const acceptance = criteriaFor(text, { intent, domains, deliverables, evidence });
  const permissions = new Set(risk.permissions);
  permissions.add('read');
  if (deliverables.some((item) => item.kind === 'file' || item.kind === 'code_change')) permissions.add('write');
  if (evidence.includes('check') || evidence.includes('execution')) permissions.add('execute');
  if (evidence.includes('fetch')) permissions.add('network');
  const spec = {
    schemaVersion: TASK_SCHEMA_VERSION,
    id: id || 'T' + (nextId++),
    parentId: parentId || '',
    source,
    digest,
    createdAt: now,
    updatedAt: now,
    turns: 1,
    intent: { kind: intent, summary: clean(trimmed.split(/(?<=[.!?])\s+|\n/)[0] || trimmed, 200) },
    domains,
    deliverables,
    constraints,
    acceptance,
    dependencies: [],
    risk: { level: risk.level, reasons: risk.reasons },
    permissions: { required: [...permissions].sort(), mode: mode || '' },
    evidence: { required: evidence },
    complexity,
    autonomy: autonomyFor({ complexity, risk, intent }),
    outcome: null
  };
  return spec;
}

/**
 * Adds model-declared deliverables, criteria and constraints. Declared
 * criteria start `open` like derived ones; nothing the model sends can set a
 * status. Returns { spec, added, errors }.
 */
export function declareOnSpec(spec, { deliverables = [], acceptance = [], constraints = [], dependencies = [] } = {}) {
  const errors = [];
  const added = [];
  const next = { ...spec, deliverables: [...spec.deliverables], acceptance: [...spec.acceptance], constraints: [...spec.constraints], dependencies: [...(spec.dependencies || [])], updatedAt: Date.now() };
  for (const item of (Array.isArray(deliverables) ? deliverables : []).slice(0, 10)) {
    const description = clean(item && item.description, 240);
    if (!description) { errors.push('a deliverable needs a description'); continue; }
    const filePath = item.path ? clean(item.path, 400) : '';
    if (filePath && (path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes('..'))) { errors.push('deliverable path ' + filePath + ' must stay inside the workspace'); continue; }
    const entry = { id: 'd' + (next.deliverables.length + 1), kind: ['file', 'code_change', 'report', 'dataset', 'plan', 'document', 'action', 'answer'].includes(item.kind) ? item.kind : (filePath ? 'file' : 'answer'), description, ...(filePath ? { path: filePath } : {}), source: 'declared' };
    next.deliverables.push(entry);
    added.push(entry.id);
    if (filePath && !next.acceptance.some((c) => c.kind === 'file_exists' && c.params.path === filePath)) {
      next.acceptance.push({ id: 'c' + (next.acceptance.length + 1), kind: 'file_exists', description: filePath + ' exists and is not empty', params: { path: filePath }, source: 'declared', status: 'open', evidence: [] });
    }
  }
  for (const item of (Array.isArray(acceptance) ? acceptance : []).slice(0, 15)) {
    const description = clean(item && item.description, 240);
    const kind = CRITERION_KINDS.includes(item && item.kind) ? item.kind : 'manual';
    if (!description) { errors.push('a criterion needs a description'); continue; }
    const params = {};
    if (kind === 'check_passes' && item.command) params.command = clean(item.command, 200);
    if (kind === 'file_exists') {
      const p = clean(item.path, 400);
      if (!p || path.isAbsolute(p) || p.split(/[\\/]/).includes('..')) { errors.push('file_exists needs a relative path inside the workspace'); continue; }
      params.path = p;
      if (item.contains) params.contains = clean(item.contains, 200);
    }
    if (kind === 'word_limit') {
      for (const key of ['min', 'max']) if (Number.isFinite(Number(item[key])) && Number(item[key]) > 0) params[key] = Math.floor(Number(item[key]));
      params.unit = ['word', 'sentence', 'bullet', 'paragraph', 'line', 'character'].includes(item.unit) ? item.unit : 'word';
      params.target = item.path ? clean(item.path, 400) : 'reply';
      if (params.target !== 'reply' && (path.isAbsolute(params.target) || params.target.split(/[\\/]/).includes('..'))) { errors.push('word_limit path must stay inside the workspace'); continue; }
      if (params.min === undefined && params.max === undefined) { errors.push('word_limit needs min or max'); continue; }
    }
    if (kind === 'cites_sources') { params.min = Math.max(1, Math.min(10, Math.floor(Number(item.min) || 1))); params.independent = Boolean(item.independent); }
    const entry = { id: 'c' + (next.acceptance.length + 1), kind, description, params, source: 'declared', status: 'open', evidence: [] };
    next.acceptance.push(entry);
    added.push(entry.id);
  }
  for (const item of (Array.isArray(constraints) ? constraints : []).slice(0, 10)) {
    const text = clean(item, 240);
    if (text && !next.constraints.includes(text)) next.constraints.push(text);
  }
  for (const dep of (Array.isArray(dependencies) ? dependencies : []).slice(0, 20)) {
    const value = clean(dep, 40);
    if (value && !next.dependencies.includes(value)) next.dependencies.push(value);
  }
  return { spec: next, added, errors };
}

function insideRoot(root, relative) {
  if (!root) return null;
  const resolved = path.resolve(root, relative);
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

function readSmall(file) {
  try {
    const info = statSync(file);
    if (!info.isFile()) return null;
    if (info.size > 2 * 1024 * 1024) return { size: info.size, text: null };
    return { size: info.size, text: readFileSync(file, 'utf8') };
  } catch { return null; }
}

/** Counts of words, sentences, bullets, paragraphs, lines and characters in text. */
export function measureText(text) {
  const value = String(text || '').replace(/```[\s\S]*?```/g, ' ');
  const prose = value.replace(/^#{1,6}\s.*$/gm, ' ');
  return {
    word: (prose.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length,
    sentence: (prose.match(/[^.!?\n]+[.!?]+(?=\s|$)/g) || []).length,
    bullet: (value.match(/^\s*(?:[-*•+]|\d+[.)])\s+\S/gm) || []).length,
    paragraph: prose.split(/\n\s*\n/).filter((part) => part.trim()).length,
    line: value.split('\n').filter((line) => line.trim()).length,
    character: value.length
  };
}

/**
 * Evaluates every criterion against what the runtime observed. Returns a new
 * acceptance list with status met | unmet | unknown and the evidence used.
 * `context`: { events, reply, root, reviews } where reviews are independent
 * verification results ({ by, verdict: 'pass' | 'fail', detail }).
 */
export function evaluateAcceptance(spec, { events = [], reply = '', root = '', reviews = [] } = {}) {
  const fetched = fetchedUrls(events);
  const assessed = assessReport(reply, events, { domains: [spec.domains.primary, ...spec.domains.secondary].includes('analysis') ? ['analysis'] : [] });
  return (spec.acceptance || []).map((criterion) => {
    const result = { ...criterion, evidence: [] };
    const set = (status, detail, evidence = []) => { result.status = status; result.detail = clean(detail, 300); result.evidence = evidence; return result; };
    switch (criterion.kind) {
      case 'check_passes': {
        const wanted = criterion.params.command ? String(criterion.params.command).toLowerCase().replace(/\s+/g, ' ').trim() : '';
        const checks = events.filter((event) => event.kind === 'check' && (!wanted || String(event.command || '').toLowerCase().replace(/\s+/g, ' ').includes(wanted)));
        const latest = checks[checks.length - 1];
        if (!latest) return set('unmet', wanted ? 'no run of `' + wanted + '` was observed' : 'no test, build or check ran');
        const editedAfter = events.some((event) => event.seq > latest.seq && (event.kind === 'edit' || event.mayEdit));
        if (latest.masked) return set('unmet', 'the exit status of `' + latest.command + '` was hidden by a pipe', [latest.seq]);
        if (!latest.finished) return set('unmet', '`' + latest.command + '` did not finish', [latest.seq]);
        if (latest.noTests) return set('unmet', '`' + latest.command + '` ran no tests', [latest.seq]);
        if (latest.passed !== true) return set('unmet', '`' + latest.command + '` exited with code ' + latest.exitCode, [latest.seq]);
        if (editedAfter) return set('unmet', 'files changed after `' + latest.command + '` passed', [latest.seq]);
        return set('met', '`' + latest.command + '` passed after the last edit', [latest.seq]);
      }
      case 'file_exists': {
        const file = insideRoot(root, criterion.params.path);
        if (!file) return set('unknown', 'no workspace to check');
        const read = existsSync(file) ? readSmall(file) : null;
        if (!read) return set('unmet', criterion.params.path + ' does not exist');
        if (!read.size) return set('unmet', criterion.params.path + ' is empty');
        if (criterion.params.contains && read.text !== null && !read.text.includes(criterion.params.contains)) return set('unmet', criterion.params.path + ' does not contain "' + criterion.params.contains + '"');
        const edit = [...events].reverse().find((event) => event.kind === 'edit' && path.resolve(root, event.path) === file);
        return set('met', criterion.params.path + ' exists (' + read.size + ' bytes)', edit ? [edit.seq] : []);
      }
      case 'word_limit': {
        let body = reply;
        let where = 'the reply';
        if (criterion.params.target && criterion.params.target !== 'reply') {
          const file = insideRoot(root, criterion.params.target);
          const read = file && existsSync(file) ? readSmall(file) : null;
          if (!read || read.text === null) return set('unknown', criterion.params.target + ' could not be read');
          body = read.text;
          where = criterion.params.target;
        }
        const count = measureText(body)[criterion.params.unit || 'word'];
        const unit = (criterion.params.unit || 'word') + 's';
        if (criterion.params.min !== undefined && count < criterion.params.min) return set('unmet', where + ' has ' + count + ' ' + unit + ', fewer than ' + criterion.params.min);
        if (criterion.params.max !== undefined && count > criterion.params.max) return set('unmet', where + ' has ' + count + ' ' + unit + ', more than ' + criterion.params.max);
        return set('met', where + ' has ' + count + ' ' + unit);
      }
      case 'cites_sources': {
        const cited = (assessed.claims.citations.checked);
        const readCited = [...fetched].filter((url) => reply.includes(url) || reply.includes(url.replace(/\/$/, '')));
        const min = criterion.params.min || 1;
        if (!cited) return set('unmet', 'the result cites no sources');
        if (assessed.claims.citations.supported < cited) return set('unmet', (cited - assessed.claims.citations.supported) + ' cited URL(s) were never fetched');
        if (criterion.params.independent) {
          const groups = independentSources(readCited.length ? readCited : [...fetched]).independent;
          if (groups < min) return set('unmet', 'only ' + groups + ' independent source(s) among the pages cited');
          return set('met', groups + ' independent sources cited and read');
        }
        if (assessed.claims.citations.supported < min) return set('unmet', 'fewer than ' + min + ' fetched sources cited');
        return set('met', assessed.claims.citations.supported + ' cited source(s), all fetched');
      }
      case 'claims_supported': {
        if (assessed.issues.length) return set('unmet', assessed.issues.map((issue) => issue.reason).join('; '));
        if (!assessed.checked) return set('unknown', 'the result makes no claim the runtime can check');
        return set('met', assessed.supported + ' checkable claim(s), all supported');
      }
      case 'side_effect': {
        // Only recorded side effects (a commit, an install, a merge, a sent
        // message) count. A command that exited 0 shows that something ran,
        // not that the requested action happened.
        const effects = events.filter((event) => event.kind === 'side_effect');
        if (!effects.length) {
          const ran = events.filter((event) => (event.kind === 'command' || event.kind === 'execution') && event.exitCode === 0).length;
          return set('unknown', ran ? ran + ' command(s) ran, but no tool result shows the requested action itself' : 'no tool result shows the action happening');
        }
        return set('met', effects.length + ' action(s) observed in tool results', effects.slice(-5).map((event) => event.seq));
      }
      case 'independent_review': {
        // Reviews of the current files only (src/task-reviews.mjs): an edit
        // after a review leaves it reviewing code that no longer exists.
        const review = combinedReview(reviews);
        if (!review) return set('unmet', 'no independent review of the current files ran');
        const status = review.verdict === 'pass' ? 'met' : review.verdict === 'fail' ? 'unmet' : 'unknown';
        return set(status, (review.by || 'reviewer') + ': ' + (review.detail || review.verdict));
      }
      default:
        return set('unknown', 'needs a person (or an independent reviewer) to judge');
    }
  });
}

/**
 * The outcome of one run of a task, as separate results:
 *
 *   execution     completed | failed | stalled | cancelled | partial
 *   evidence      what tool results the run left (counts by kind)
 *   claims        checkable claims in the result and how many were supported
 *   acceptance    criteria met / unmet / unknown
 *   independent   whether a separate agent or check verified the result
 *
 * and a verdict derived from them, in order of strength:
 *
 *   failed, cancelled   the run did not complete
 *   incomplete          it stopped at a limit
 *   rejected            a claim was unsupported or a checkable criterion unmet
 *   unverified          completed, but nothing about the result was checked
 *   evidenced           every checked claim was supported; some criteria
 *                       could not be judged by the runtime
 *   verified            every runtime-checkable criterion met, and at least
 *                       one claim or criterion was actually checked
 *   independently_verified   verified, and an independent review passed
 *
 * Tool activity alone never raises the verdict: a run that fetched ten pages
 * and cited none of them is unverified, not verified.
 */
export function assessOutcome(spec, { status = 'completed', partial = false, events = [], reply = '', root = '', reviews = [], staleReviews = 0, domains = [] } = {}) {
  const counts = {};
  for (const event of events) counts[event.kind] = (counts[event.kind] || 0) + 1;
  const declaredDomains = [...new Set([...(domains || []), ...(spec ? [spec.domains.primary, ...spec.domains.secondary] : [])])].filter((domain) => domain === 'analysis');
  const report = assessReport(reply, events, { domains: declaredDomains });
  const ledger = buildClaims(reply, events, { analysis: declaredDomains.includes('analysis') });
  // Claims that rest on one reading of one source, or on inference, are
  // evidence, not verification: the attribution was checked, the fact was not.
  const softClaims = ledger.claims.filter((claim) => claim.status === 'inferred' || claim.status === 'stale' || (claim.status === 'reported' && (claim.independentSources || 0) < 2));
  const acceptance = spec ? evaluateAcceptance(spec, { events, reply, root, reviews }) : [];
  const tally = { total: acceptance.length, met: 0, unmet: 0, unknown: 0 };
  for (const item of acceptance) tally[item.status === 'met' ? 'met' : item.status === 'unmet' ? 'unmet' : 'unknown'] += 1;
  const review = combinedReview(reviews);
  const independent = { required: Boolean(spec && spec.autonomy && spec.autonomy.verification === 'independent'), done: Boolean(review), passed: Boolean(review && review.verdict === 'pass'), verdict: review ? review.verdict : null, by: review ? review.by || '' : '', ...(staleReviews ? { stale: staleReviews } : {}) };
  const execution = ['failed', 'stalled', 'cancelled'].includes(status) ? status : partial ? 'partial' : status === 'completed' ? 'completed' : 'failed';
  let verdict;
  if (execution === 'cancelled') verdict = 'cancelled';
  else if (execution === 'failed' || execution === 'stalled') verdict = 'failed';
  else if (execution === 'partial') verdict = 'incomplete';
  else if (report.issues.length || tally.unmet || (review && review.verdict === 'fail')) verdict = 'rejected';
  else if (!report.checked && !tally.met) verdict = 'unverified';
  else if (tally.unknown || softClaims.length) verdict = 'evidenced';
  else verdict = independent.passed ? 'independently_verified' : 'verified';
  return {
    verdict,
    execution,
    evidence: { events: events.length, counts },
    claims: { checked: report.checked, supported: report.supported, byKind: report.claims, byStatus: ledger.counts, items: ledger.claims, issues: report.issues.map(({ domain, reason }) => ({ domain, reason })) },
    acceptance: { ...tally, criteria: acceptance.map(({ id, kind, description, status: s, detail, evidence }) => ({ id, kind, description, status: s, ...(detail ? { detail } : {}), ...(evidence && evidence.length ? { evidence } : {}) })) },
    independent,
    assessedAt: Date.now()
  };
}

/** True when the verdict counts as a verified success for learning and routing. */
export function verdictIsVerified(verdict) {
  return verdict === 'verified' || verdict === 'independently_verified';
}

/** Criteria the runtime can check that are still unmet: what a completion gate sends back. */
export function unmetCheckable(outcome) {
  if (!outcome || !outcome.acceptance) return [];
  return outcome.acceptance.criteria.filter((item) => item.status === 'unmet' && item.kind !== 'manual' && item.kind !== 'independent_review');
}

/** A compact prompt block for the model: what will be checked. '' for trivial tasks. */
export function taskBrief(spec) {
  if (!spec || spec.complexity === 'trivial') return '';
  const checkable = (spec.acceptance || []).filter((item) => item.kind !== 'manual');
  // Tests after edits and backed claims are standing rules in the system
  // prompt, and the gate enforces them either way, so a brief appears only
  // for what the request itself spelled out (a file, a length, sources, an
  // action) or when the task needs planning or independent review. Kept
  // short: it rides on every request of the turn.
  const specific = checkable.filter((item) => !['check_passes', 'claims_supported'].includes(item.kind));
  const planning = spec.autonomy.planning === 'explicit' && spec.complexity === 'complex';
  const independent = spec.autonomy.verification === 'independent';
  if (!specific.length && !planning && !independent) return '';
  if (spec.complexity === 'simple' && !specific.some((item) => ['file_exists', 'word_limit', 'cites_sources'].includes(item.kind))) return '';
  const lines = ['<task-contract id="' + spec.id + '">' + spec.intent.kind + ', ' + spec.domains.primary + ', ' + spec.complexity + ', risk ' + spec.risk.level + (spec.risk.reasons.length ? ' (' + spec.risk.reasons.join(', ') + ')' : '') + '.'];
  if (checkable.length) {
    lines.push('Checked against tool results before you finish:');
    for (const item of checkable) lines.push('- ' + item.id + ' ' + item.description);
  }
  if (planning) lines.push('Plan it with todo_write before acting.');
  if (independent) lines.push('Have it checked independently (a review subagent or a separate check) before calling it done.');
  lines.push('Wrong or missing criteria: fix them with task_contract (you cannot mark them met).');
  lines.push('</task-contract>');
  return lines.join('\n');
}

/**
 * What the main-turn completion gate holds a final answer to: unmet
 * criteria the runtime can check, and claims in the reply the evidence did
 * not back. Code checks are left to the post-edit verification gate and the
 * claim check (src/completion-gates.mjs), which already own them.
 * Returns [{ kind, description, detail }].
 */
export function gateProblems(outcome) {
  if (!outcome || !outcome.acceptance) return [];
  const out = [];
  for (const item of outcome.acceptance.criteria) {
    if (item.status !== 'unmet' || ['check_passes', 'claims_supported', 'manual', 'independent_review'].includes(item.kind)) continue;
    out.push({ kind: item.kind, description: item.description, detail: item.detail || '' });
  }
  for (const issue of (outcome.claims && outcome.claims.issues) || []) {
    if (issue.domain === 'code') continue;
    out.push({ kind: 'claim', description: issue.domain + ' claim not backed by evidence', detail: issue.reason });
  }
  return out;
}

/**
 * Whether a reply already tells the user the work was not done ("Could not
 * write.", "I was unable to fetch it"). The gate exists to catch answers that
 * present unfinished work as finished; an answer that admits the shortfall
 * gets no nudge and no extra notice, though the outcome is still recorded
 * as unverified.
 */
export function admitsShortfall(text) {
  return /\b(could not|couldn['’]t|can(?:not|['’]t)|unable to|was not able|wasn['’]t able|failed to|did not (?:manage|succeed)|didn['’]t (?:manage|succeed)|was (?:denied|blocked)|not (?:done|finished|completed)|no permission)\b/i.test(String(text || ''));
}

/** The completion gate's note to the model, listing gateProblems(). */
export function taskGateNudge(problems) {
  return '<system-reminder>Before you finish, OASIS checked your answer against this turn\'s tool results and found:\n'
    + problems.slice(0, 8).map((item) => '- ' + (item.detail || item.description)).join('\n')
    + '\nFix what you can now (write the missing file, fetch the page you cite or drop the citation, rerun the calculation and use its output). If something cannot be done, say so plainly in your answer instead of presenting it as done. This note is internal; do not mention it.</system-reminder>';
}

/** One line for the user naming what remained unverified after the gate, or ''. */
export function gateNotice(problems) {
  if (!problems || !problems.length) return '';
  return 'Not verified: ' + problems.slice(0, 4).map((item) => item.detail || item.description).join('; ') + '.';
}

/** One short line for the user about a finished task, or '' when nothing needs saying. */
export function outcomeNotice(outcome) {
  if (!outcome) return '';
  const unmet = outcome.acceptance.criteria.filter((item) => item.status === 'unmet');
  if (!unmet.length) return '';
  return 'Not verified: ' + unmet.slice(0, 4).map((item) => item.description + (item.detail ? ' (' + item.detail + ')' : '')).join('; ') + '.';
}

/** A JSON-safe copy of a spec, bounded, for results, sessions and events. */
export function specSummary(spec) {
  if (!spec) return null;
  return {
    id: spec.id, parentId: spec.parentId || undefined, source: spec.source, intent: spec.intent.kind, summary: spec.intent.summary,
    domains: [spec.domains.primary, ...spec.domains.secondary], complexity: spec.complexity, risk: spec.risk,
    deliverables: spec.deliverables.map(({ id, kind, description, path: p }) => ({ id, kind, description, ...(p ? { path: p } : {}) })),
    acceptance: spec.acceptance.map(({ id, kind, description, source, status }) => ({ id, kind, description, source, status })),
    constraints: spec.constraints, dependencies: spec.dependencies || [], permissions: spec.permissions.required, evidence: spec.evidence.required,
    autonomy: spec.autonomy, ...(spec.outcome ? { outcome: { verdict: spec.outcome.verdict, execution: spec.outcome.execution, claims: { checked: spec.outcome.claims.checked, supported: spec.outcome.claims.supported, ...(spec.outcome.claims.byStatus ? { byStatus: spec.outcome.claims.byStatus } : {}) }, acceptance: { total: spec.outcome.acceptance.total, met: spec.outcome.acceptance.met, unmet: spec.outcome.acceptance.unmet, unknown: spec.outcome.acceptance.unknown }, independent: spec.outcome.independent } } : {})
  };
}

/**
 * On unless OASIS_TASK_MODEL=0 or settings "taskModel": false. Off, turns get
 * no task contract and the completion gate skips acceptance.
 */
export function taskModelEnabled(session, env = process.env) {
  if (/^(0|false|off|no)$/i.test(String(env && env.OASIS_TASK_MODEL || ''))) return false;
  return !(session && session.settings && session.settings.taskModel === false);
}

/** Restores a saved spec (session resume). Unknown or damaged input gives null. */
export function restoreSpec(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== TASK_SCHEMA_VERSION) return null;
  if (!value.intent || !value.domains || !Array.isArray(value.acceptance)) return null;
  return value;
}
