// Credential detection with Gitleaks' maintained rule set (MIT,
// https://github.com/gitleaks/gitleaks), converted to ECMAScript by
// scripts/update-secret-rules.mjs into src/data/secret-rules.json.
//
// Matching follows Gitleaks' detector: a rule runs only when one of its
// keywords appears (case-insensitively); the secret is the rule's secretGroup
// or else the first non-empty capture group; rules with an entropy threshold
// drop low-entropy values; rule and global allowlists (regexes against the
// secret, match or line, and stopwords) drop known non-secrets.
import fs from 'node:fs';

const SNAPSHOT = new URL('./data/secret-rules.json', import.meta.url);

let compiled = null;

function compile() {
  if (compiled) return compiled;
  const data = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  const rules = [];
  for (const rule of data.rules || []) {
    try {
      rules.push({
        id: rule.id,
        re: new RegExp(rule.regex, 'gd'),
        keywords: rule.keywords || [],
        entropy: rule.entropy || 0,
        secretGroup: rule.secretGroup || 0,
        path: rule.path ? new RegExp(rule.path) : null,
        allow: (rule.allow || []).map((list) => ({
          regexes: (list.regexes || []).map((source) => new RegExp(source)),
          stopwords: list.stopwords || [],
          target: list.target || 'secret',
          all: Boolean(list.all)
        }))
      });
    } catch {}
  }
  const allow = { regexes: ((data.allow && data.allow.regexes) || []).map((source) => new RegExp(source)), stopwords: (data.allow && data.allow.stopwords) || [] };
  compiled = { rules, allow, count: rules.length };
  return compiled;
}

export function secretRuleCount() { return compile().count; }

export function shannonEntropy(value) {
  const text = String(value || '');
  if (!text) return 0;
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) || 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function lineAround(text, start, end) {
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const to = text.indexOf('\n', end);
  return text.slice(from, to < 0 ? text.length : to);
}

function allowed(list, values) {
  const checks = [];
  if (list.regexes.length) {
    const target = list.target === 'match' ? values.match : list.target === 'line' ? values.line() : values.secret;
    checks.push(list.regexes.some((re) => re.test(target)));
  }
  if (list.stopwords.length) {
    const lower = values.secret.toLowerCase();
    checks.push(list.stopwords.some((word) => lower.includes(word)));
  }
  if (!checks.length) return false;
  return list.all ? checks.every(Boolean) : checks.some(Boolean);
}

/**
 * Finds credentials in text. Returns [{ rule, secret, start, end }] sorted by
 * position, where start/end bound the secret itself, without overlaps. Rules
 * scoped to file paths run only when options.path matches.
 */
export function findRuleSecrets(text, { path = '' } = {}) {
  const value = String(text || '');
  if (!value) return [];
  const { rules, allow } = compile();
  const lower = value.toLowerCase();
  const hits = [];
  for (const rule of rules) {
    if (rule.path && !(path && rule.path.test(path))) continue;
    if (rule.keywords.length && !rule.keywords.some((word) => lower.includes(word))) continue;
    rule.re.lastIndex = 0;
    for (const match of value.matchAll(rule.re)) {
      let index = 0;
      if (rule.secretGroup && match[rule.secretGroup] !== undefined) index = rule.secretGroup;
      else if (!rule.secretGroup) for (let g = 1; g < match.length; g++) if (match[g]) { index = g; break; }
      let secret = match[index];
      if (!secret) continue;
      let [start, end] = match.indices[index];
      // Gitleaks trims a trailing newline that a pattern swallowed.
      while (secret.endsWith('\n') || secret.endsWith('\r')) { secret = secret.slice(0, -1); end--; }
      if (rule.entropy && shannonEntropy(secret) < rule.entropy) continue;
      const values = { secret, match: match[0], line: () => lineAround(value, match.index, match.index + match[0].length) };
      if (allow.regexes.some((re) => re.test(secret))) continue;
      if (allow.stopwords.length && allow.stopwords.some((word) => secret.toLowerCase().includes(word))) continue;
      if (rule.allow.some((list) => allowed(list, values))) continue;
      hits.push({ rule: rule.id, secret, start, end });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const hit of hits) {
    const last = merged[merged.length - 1];
    if (last && hit.start < last.end) {
      if (hit.end > last.end) { last.end = hit.end; last.secret = value.slice(last.start, last.end); }
      continue;
    }
    merged.push({ ...hit });
  }
  return merged;
}
