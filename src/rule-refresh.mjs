// Rule refresh. A widely reported failure: CLAUDE.md / AGENTS.md rules are
// followed at the start of a session and then quietly dropped as tool output
// piles up ("it read the rule, acknowledged it, then did it anyway"). The
// instruction files stay in the system prompt, but attention to them decays.
//
// Two remedies:
//  1. The hard rules (NEVER / ALWAYS / MUST / DO NOT lines) are pulled out of the
//     instruction files and restated as a short reminder whenever the
//     conversation has grown a lot since they were last seen, or after compaction.
//  2. Branch rules that tooling can check ("never commit to main", "don't push to
//     master") are enforced: such a commit or push is refused before it runs.

const INSTRUCTION_SOURCE = /^---\s+(?:[\w ]+):\s+(.+?)\s+---$/;
const README_LIKE = /(?:^|\/)(?:readme|changelog|contributing|license|code_of_conduct)(?:\.[\w-]+)?$/i;
const HARD_RULE = /\b(?:never|always|must(?:\s+not)?|do\s+not|don['’]t|mustn['’]t|only\s+ever|under\s+no\s+circumstances|important|required?|forbidden|prohibited)\b/i;
const MAX_RULES = 15;
const MAX_RULE_CHARS = 220;
const MAX_TOTAL = 2000;
export const RULE_REFRESH_GROWTH_CHARS = 60000;

function sections(projectContext) {
  const result = [];
  let current = null;
  for (const line of String(projectContext || '').split('\n')) {
    const header = line.match(INSTRUCTION_SOURCE);
    if (header) {
      current = { name: header[1].trim(), lines: [] };
      result.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return result;
}

// Hard rules from instruction files (CLAUDE.md, AGENTS.md, OASIS.md, rules files), not README-style docs.
export function extractHardRules(projectContext) {
  const rules = [];
  const seen = new Set();
  let total = 0;
  for (const section of sections(projectContext)) {
    if (README_LIKE.test(section.name)) continue;
    let inFence = false;
    for (const raw of section.lines) {
      if (/^\s*```/.test(raw)) { inFence = !inFence; continue; }
      if (inFence) continue;
      const line = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
      if (line.length < 8 || /^#/.test(line) || /^<!--/.test(line) || !HARD_RULE.test(line)) continue;
      const clipped = line.length > MAX_RULE_CHARS ? line.slice(0, MAX_RULE_CHARS - 1).trimEnd() + '…' : line;
      const key = clipped.toLowerCase();
      if (seen.has(key)) continue;
      if (total + clipped.length > MAX_TOTAL || rules.length >= MAX_RULES) return rules;
      seen.add(key);
      rules.push(clipped);
      total += clipped.length;
    }
  }
  return rules;
}

export function ruleRefreshEnabled(env = process.env) {
  return !/^(0|false|off|no)$/i.test(String(env.OASIS_RULE_REFRESH || ''));
}

// Decide whether this turn should restate the rules, and update the tracking state.
export function ruleRefreshReminder(session, { historyChars = 0, compacted = false, env = process.env } = {}) {
  if (!session || !ruleRefreshEnabled(env)) return '';
  const rules = Array.isArray(session.hardRules) ? session.hardRules : [];
  if (!rules.length) return '';
  const last = Number.isFinite(session.rulesRefreshedAtChars) ? session.rulesRefreshedAtChars : 0;
  // History shrinks after compaction: treat that as "rules may be lost from view".
  const due = compacted || historyChars < last || historyChars - last >= RULE_REFRESH_GROWTH_CHARS;
  if (!due) return '';
  session.rulesRefreshedAtChars = historyChars;
  return '<project-rules-reminder>\nThe project instructions set these rules. They still apply for the rest of this session:\n' +
    rules.map((rule) => '- ' + rule).join('\n') + '\n</project-rules-reminder>';
}

// ---------------------------------------------------------------- branch rules

const BRANCH_RULE = /\b(?:never|do\s+not|don['’]t|must\s+not|mustn['’]t|no)\s+(?:ever\s+)?(?:directly\s+)?(commit|push)(?:es|ing|s)?\s+(?:directly\s+|straight\s+)?(?:(?:to|on|into)\s+)(?:the\s+)?[`'"]?([\w./-]+)[`'"]?(?:\s+branch)?(?:\s+(?:or|and|\/)\s+[`'"]?([\w./-]+)[`'"]?(?:\s+branch)?)?/gi;
const BRANCH_WORD = /^(?:main|master|trunk|develop|dev|production|prod|release|staging|default|protected)$/i;

export function extractBranchRules(projectContext) {
  const rules = { commit: new Set(), push: new Set() };
  for (const section of sections(projectContext)) {
    if (README_LIKE.test(section.name)) continue;
    const text = section.lines.join('\n').replace(/\*\*|__|\*|`/g, '');
    for (const match of text.matchAll(BRANCH_RULE)) {
      const verb = match[1].toLowerCase();
      for (const branch of [match[2], match[3]]) {
        const name = String(branch || '').replace(/[./-]+$/, '').toLowerCase();
        if (!name || !BRANCH_WORD.test(name)) continue;
        rules[verb].add(name);
        // Not committing to a branch implies not pushing commits made on it either.
        if (verb === 'commit') rules.push.add(name);
      }
    }
  }
  return { commit: [...rules.commit], push: [...rules.push] };
}

// Returns a refusal message when a commit or push would break a branch rule.
export function branchRuleViolation(rules, { action, branch, pushTargets = [] }) {
  if (!rules || !branch && !pushTargets.length) return '';
  const list = action === 'push' ? rules.push : rules.commit;
  if (!Array.isArray(list) || !list.length) return '';
  const targets = action === 'push' && pushTargets.length ? pushTargets : [branch];
  const hit = targets.map((value) => String(value || '').toLowerCase()).find((value) => list.includes(value) || (list.includes('default') && /^(?:main|master)$/.test(value)));
  if (!hit) return '';
  return 'Blocked by a project rule: the project instructions say never to ' + action + ' ' + (action === 'push' ? 'to' : 'on') + ' `' + hit + '`. ' +
    (action === 'commit' ? 'Create a feature branch first (git switch -c <name>), commit there, and tell the user.' : 'Push a feature branch instead and let the user merge it.') +
    ' If the user explicitly asks to override this rule for this change, they can run the command themselves.';
}

// Extract the refs a `git push` command line would update (best effort).
export function pushTargetsFromArgs(args, currentBranch) {
  const list = (args || []).map(String).filter((arg) => arg && !arg.startsWith('-'));
  // git push [remote] [refspec...]
  const refspecs = list.slice(1);
  if (!refspecs.length) return currentBranch ? [currentBranch] : [];
  return refspecs.map((spec) => {
    const target = spec.includes(':') ? spec.split(':').pop() : spec;
    return target.replace(/^\+/, '').replace(/^refs\/heads\//, '') || currentBranch;
  }).filter(Boolean);
}
