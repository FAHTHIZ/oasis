// Composer autocomplete: "/" for commands and skills, "@" for project files.
// Pure helpers so the ranking and text edits are testable without a DOM.
import fuzzysort from 'fuzzysort';

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

/**
 * Rank items by how well `query` matches `key(item)`, with fuzzysort (MIT):
 * contiguous runs and matches at path-segment, word and camelCase starts score
 * highest, so "agent" puts src/agent.mjs first and "mdm" still finds
 * src/markdown.mjs. Ties keep the original order (built-ins before custom
 * commands, or the workspace's file order); an empty query lists the first items.
 */
export function rankSuggestions(items, query, key = (item) => String(item), limit = 8) {
  const list = Array.isArray(items) ? items : [];
  const max = Math.max(1, limit);
  const search = String(query || '').trim();
  if (!search) return list.slice(0, max);
  const scored = [];
  list.forEach((item, index) => {
    // prepare() rather than a raw string: fuzzysort's global cache would keep every path alive.
    const hit = fuzzysort.single(search, fuzzysort.prepare(String(key(item) || '')));
    if (hit) scored.push({ item, index, score: hit.score });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, max).map((entry) => entry.item);
}

/** Replace the token with the chosen completion. Returns the new value and caret. */
export function applySuggestion(value, token, completion) {
  const text = String(value || '');
  const rest = text.slice(token.end);
  const insert = (token.kind === 'app' ? '' : token.kind) + String(completion || '') + (rest.startsWith(' ') ? '' : ' ');
  const next = text.slice(0, token.start) + insert + rest;
  return { value: next, caret: token.start + insert.length };
}
