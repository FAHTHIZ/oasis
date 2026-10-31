// Standing corrections: "stop saying 'load-bearing'" should stick.
//
// Users report telling Claude Code to drop a phrase, only for compaction or a new
// session to erase the instruction and the phrase to come straight back. Here a
// correction is captured from the user's own message, remembered for the session
// (and in user memory, so later sessions inherit it), restated on every turn so
// compaction cannot drop it, and enforced: a final reply that still uses a banned
// phrase is sent back once for a rewrite.

const QUOTED_TEXT = '(?:"([^"\\n]{2,48})"|“([^”\\n]{2,48})”|‘([^’\\n]{2,48})’|\'([^\'\\n]{2,48})\')';
const QUOTED = [
  new RegExp('\\b(?:stop|quit|avoid)\\s+(?:saying|writing|using\\s+the\\s+(?:word|phrase|term|expression))\\s+(?:the\\s+(?:word|phrase|term|expression)\\s+)?' + QUOTED_TEXT, 'gi'),
  new RegExp('\\b(?:don\'?t|do not|never)\\s+(?:ever\\s+)?(?:say|write|use\\s+the\\s+(?:word|phrase|term|expression))\\s+(?:the\\s+(?:word|phrase|term|expression)\\s+)?' + QUOTED_TEXT, 'gi')
];
// Unquoted form, e.g. "stop saying load-bearing" or "stop saying you're absolutely right".
const UNQUOTED = /\bstop\s+(?:saying|using\s+the\s+(?:word|phrase))\s+([a-z][\w'’-]*(?:\s+[a-z][\w'’-]*){0,3})/gi;
const CONNECTOR = /\s+(?:and|or|but|in|when|every|all|because|please|so|to|for|at|if|then|everywhere|anymore|again|all the time)\b.*$/i;
const VAGUE = new Set(['that', 'this', 'it', 'those', 'these', 'things', 'stuff', 'so', 'that stuff', 'the same thing', 'things like that']);
const MAX_CORRECTIONS = 30;

function normalizePhrase(value) {
  return String(value || '').replace(/[’]/g, "'").replace(/\s+/g, ' ').replace(/^[\s,.;:!?-]+|[\s,.;:!?]+$/g, '').trim();
}

export function extractCorrections(text) {
  const value = String(text || '');
  const found = new Map();
  const add = (raw) => {
    const phrase = normalizePhrase(raw);
    if (phrase.length < 2 || phrase.length > 48 || VAGUE.has(phrase.toLowerCase())) return;
    if (!/[a-z]/i.test(phrase)) return;
    found.set(phrase.toLowerCase(), phrase);
  };
  for (const pattern of QUOTED) for (const match of value.matchAll(pattern)) add(match.slice(1).find((group) => group !== undefined));
  for (const match of value.matchAll(UNQUOTED)) {
    const phrase = match[1].replace(CONNECTOR, '');
    if (/^(?:that|this|it|those|these|the|such|stuff|things|so|sorry about)\b/i.test(phrase) && !/^sorry$/i.test(phrase)) continue;
    add(phrase);
  }
  return [...found.values()];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phrasePattern(phrase) {
  const body = escapeRegExp(normalizePhrase(phrase)).replace(/'/g, "['’]").replace(/\s+/g, '\\s+');
  const start = /^\w/.test(phrase) ? '(?<![\\w-])' : '';
  const end = /\w$/.test(phrase) ? '(?![\\w-])' : '';
  return new RegExp(start + body + end, 'i');
}

// Banned phrases still present in a reply, ignoring fenced and inline code.
export function correctionViolations(corrections, text) {
  if (!Array.isArray(corrections) || !corrections.length) return [];
  const prose = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  return corrections.filter((phrase) => phrasePattern(phrase).test(prose));
}

export function addCorrections(session, phrases) {
  if (!session) return [];
  const list = session.standingCorrections || (session.standingCorrections = []);
  const known = new Set(list.map((item) => item.toLowerCase()));
  const added = [];
  for (const phrase of phrases || []) {
    const clean = normalizePhrase(phrase);
    if (!clean || known.has(clean.toLowerCase())) continue;
    list.push(clean);
    known.add(clean.toLowerCase());
    added.push(clean);
  }
  if (list.length > MAX_CORRECTIONS) list.splice(0, list.length - MAX_CORRECTIONS);
  return added;
}

export function removeCorrection(session, phrase) {
  const list = (session && session.standingCorrections) || [];
  const index = list.findIndex((item) => item.toLowerCase() === normalizePhrase(phrase).toLowerCase());
  if (index < 0) return false;
  list.splice(index, 1);
  return true;
}

export function correctionsReminder(corrections) {
  if (!Array.isArray(corrections) || !corrections.length) return '';
  return '<standing-corrections>\nThe user has asked you never to use these words or phrases in your replies: ' +
    corrections.map((phrase) => JSON.stringify(phrase)).join(', ') + '. Phrase things differently.\n</standing-corrections>';
}

export function correctionNudge(violations) {
  return 'Your reply uses ' + violations.map((phrase) => JSON.stringify(phrase)).join(', ') +
    ', which the user explicitly asked you to stop using. Rewrite the reply without ' + (violations.length > 1 ? 'them' : 'it') +
    '. Keep the content the same; do not mention this correction.';
}

export const CORRECTION_MEMORY_PREFIX = 'Avoid phrase: ';

export function correctionsFromMemories(memories) {
  return (memories || [])
    .filter((memory) => memory && typeof memory.name === 'string' && memory.name.startsWith(CORRECTION_MEMORY_PREFIX))
    .map((memory) => memory.name.slice(CORRECTION_MEMORY_PREFIX.length).trim())
    .filter(Boolean);
}
