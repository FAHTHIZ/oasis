// Persistent writing rules: phrases to avoid and how many code comments to add.
//
// The two most-reacted complaints about Claude Code's behavior are "adds code
// comments even when told to stop" and stock phrases ("load-bearing",
// "belt-and-suspenders") that come back after every compaction, because
// corrections given in chat are summarized away. These rules live in settings
// and the system prompt, so they survive compaction and new sessions.
//
// Settings: "avoidPhrases": ["..."], "codeComments": "none" | "minimal".
// OASIS_AVOID_PHRASES=0 drops the built-in phrase list.

export const DEFAULT_AVOID_PHRASES = ['load-bearing', 'belt-and-suspenders'];
const BLOCK = /\n*<writing-rules>[\s\S]*?<\/writing-rules>/g;

/** Clean phrase list: short single-line text only, so settings cannot smuggle prompt text. */
export function normalizePhrases(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const phrase = String(item || '').replace(/\s+/g, ' ').trim();
    if (!phrase || phrase.length > 60 || /[<>{}`]/.test(phrase)) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(phrase);
    if (out.length >= 40) break;
  }
  return out;
}

export function normalizeCommentMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return mode === 'none' || mode === 'minimal' ? mode : null;
}

export function effectivePhrases(settings = {}, env = process.env) {
  const defaults = /^(?:0|false|off|no)$/i.test(String(env.OASIS_AVOID_PHRASES || '')) ? [] : DEFAULT_AVOID_PHRASES;
  return normalizePhrases([...defaults, ...normalizePhrases(settings.avoidPhrases)]);
}

export function writingRulesBlock(phrases, commentMode) {
  const lines = [];
  if (phrases.length) lines.push('Never use these words or phrases in replies, comments, commit messages or docs: ' + phrases.map((p) => '"' + p + '"').join(', ') + '. Say it plainly instead.');
  if (commentMode === 'none') lines.push('Do not add code comments. Leave existing comments as they are unless the change makes one wrong.');
  if (commentMode === 'minimal') lines.push('Add a code comment only when the why is not obvious from the code. Never narrate what the next line does, and never leave comments addressed to the user or about the edit itself.');
  return lines.length ? '<writing-rules>\n' + lines.join('\n') + '\n</writing-rules>' : '';
}

export function withWritingRules(systemText, phrases, commentMode) {
  const base = String(systemText || '').replace(BLOCK, '');
  const block = writingRulesBlock(phrases, commentMode);
  return block ? base + '\n\n' + block : base;
}

export function applyWritingRules(session, phrases, commentMode) {
  session.avoidPhrases = phrases;
  session.commentMode = commentMode || null;
  for (const key of ['baseSystemPrompt', 'mcpSystemPromptBase']) {
    if (typeof session[key] === 'string') session[key] = withWritingRules(session[key], phrases, commentMode);
  }
  const first = session.messages && session.messages[0];
  if (first && first.role === 'system' && typeof first.content === 'string') first.content = withWritingRules(first.content, phrases, commentMode);
}

const SLASH_COMMENT = /^\s*(?:\/\/|\/\*|\*(?!\*?\/?\s*$)\s)/;
const HASH_COMMENT = /^\s*#(?![!\[{])(?:\s|$)/;
const HTML_COMMENT = /^\s*<!--/;
const DASH_COMMENT = /^\s*--\s/;
const NO_HASH = /\.(?:[cm]?[jt]sx?|css|scss|sass|less|html?|vue|svelte|java|kt|kts|go|rs|c|h|cc|cpp|hpp|cs|swift|dart|scala|json|jsonc|sql|lua|hs)$/i;
const DASH_LANGS = /\.(?:sql|lua|hs|elm|ada|adb|ads)$/i;
const HTML_LANGS = /\.(?:html?|xml|svg|vue|svelte|jsx|tsx|astro)$/i;

function isCommentLine(line, displayPath) {
  const file = String(displayPath || '');
  if (SLASH_COMMENT.test(line)) return true;
  if (!NO_HASH.test(file) && HASH_COMMENT.test(line)) return true;
  if (HTML_LANGS.test(file) && HTML_COMMENT.test(line)) return true;
  if (DASH_LANGS.test(file) && DASH_COMMENT.test(line)) return true;
  return false;
}

/** Comment lines in next that were not in previous. */
export function addedCommentLines(previous, next, displayPath = '') {
  const before = new Map();
  for (const line of String(previous || '').split(/\r?\n/)) if (isCommentLine(line, displayPath)) before.set(line.trim(), (before.get(line.trim()) || 0) + 1);
  const added = [];
  for (const line of String(next || '').split(/\r?\n/)) {
    if (!isCommentLine(line, displayPath)) continue;
    const key = line.trim();
    const count = before.get(key) || 0;
    if (count > 0) before.set(key, count - 1); else added.push(key);
  }
  return added;
}

/** Warning for tool results when codeComments is "none" and an edit added comments. */
export function commentWarning(previous, next, displayPath, commentMode) {
  if (commentMode !== 'none' || /\.(?:md|markdown|txt|rst|adoc)$/i.test(String(displayPath || ''))) return '';
  const added = addedCommentLines(previous, next, displayPath);
  if (!added.length) return '';
  return 'Comment rule: the user asked for no new code comments, but this edit added ' + added.length + ' comment line(s) to ' + displayPath +
    ' (for example: ' + added[0].slice(0, 80) + '). Remove them with another edit.';
}
