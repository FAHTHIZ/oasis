// Composer autocomplete: "/" for commands and skills, "@" for project files.
// Pure helpers so the ranking and text edits are testable without a DOM.

/**
 * The completion token under the caret, or null.
 * "/" only counts at the very start of the message (as in Claude Code and
 * Codex); "@" counts at the start or after whitespace.
 */
export function suggestToken(value, caret = String(value || '').length) {
  const text = String(value || '');
  const end = Math.max(0, Math.min(Number(caret) || 0, text.length));
  const before = text.slice(0, end);
  // "/connect gi" suggests apps to connect.
  const app = /^\/connect\s+(\S*)$/i.exec(before);
  if (app) return { kind: 'app', query: app[1], start: end - app[1].length, end };
  if (before.startsWith('/') && !/\s/.test(before)) {
    return { kind: '/', query: before.slice(1), start: 0, end };
  }
  const at = before.lastIndexOf('@');
  if (at >= 0 && (at === 0 || /\s/.test(before[at - 1]))) {
    const query = before.slice(at + 1);
    if (!/\s/.test(query) && query.length <= 200) return { kind: '@', query, start: at, end };
  }
  return null;
}

function subsequence(needle, haystack) {
  let i = 0;
  for (const ch of haystack) if (ch === needle[i]) i += 1;
  return i === needle.length;
}

/**
 * Rank items by how well `query` matches `key(item)`: exact, then prefix, then
 * prefix of a path segment or word, then substring, then in-order letters.
 * Ties keep the original order (built-ins before custom commands, or the
 * workspace's file order).
 */
export function rankSuggestions(items, query, key = (item) => String(item), limit = 8) {
  const q = String(query || '').toLowerCase();
  const scored = [];
  (Array.isArray(items) ? items : []).forEach((item, index) => {
    const name = String(key(item) || '');
    const lower = name.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    let score;
    if (!q) score = 5;
    else if (lower === q || base === q) score = 0;
    else if (lower.startsWith(q)) score = 1;
    else if (base.startsWith(q)) score = 2;
    else if (lower.split(/[/._\-\s]/).some((part) => part.startsWith(q))) score = 3;
    else if (lower.includes(q)) score = 4;
    else if (q.length > 1 && subsequence(q, lower)) score = 6;
    else return;
    scored.push({ item, score, index, length: name.length });
  });
  scored.sort((a, b) => a.score - b.score || (a.score >= 2 && a.score <= 4 ? a.length - b.length : 0) || a.index - b.index);
  return scored.slice(0, Math.max(1, limit)).map((entry) => entry.item);
}

/** Replace the token with the chosen completion. Returns the new value and caret. */
export function applySuggestion(value, token, completion) {
  const text = String(value || '');
  const rest = text.slice(token.end);
  const insert = (token.kind === 'app' ? '' : token.kind) + String(completion || '') + (rest.startsWith(' ') ? '' : ' ');
  const next = text.slice(0, token.start) + insert + rest;
  return { value: next, caret: token.start + insert.length };
}
