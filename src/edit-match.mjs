// Tolerant matching for edit_file. Exact matching stays the default; these
// fallbacks only apply when the exact old_string is not found, and only when
// the relaxed match is unique, so they never change which text gets replaced
// in ambiguous situations. When nothing matches, a closest-match hint shows
// the model the real text so it can fix the edit in one step instead of
// guessing repeatedly.

const QUOTES = [[/[\u2018\u2019\u201A\u201B\u2032]/g, "'"], [/[\u201C\u201D\u201E\u201F\u2033]/g, '"'], [/[\u2013\u2014]/g, '-'], [/\u00A0/g, ' ']];

function normalizeQuotes(text) {
  let value = text;
  for (const [pattern, replacement] of QUOTES) value = value.replace(pattern, replacement);
  return value;
}

function lineNormalizers() {
  return [
    { name: 'line endings and trailing whitespace', line: (line) => line.replace(/\r$/, '').replace(/[ \t]+$/, '') },
    { name: 'typographic quotes', line: (line) => normalizeQuotes(line.replace(/\r$/, '').replace(/[ \t]+$/, '')) },
    { name: 'indentation', line: (line) => normalizeQuotes(line.replace(/\r$/, '').trim()) },
    // Spacing inside a line ("a":1 vs "a": 1, f(x,y) vs f(x, y)). Only spaces
    // next to punctuation are ignored; a space between two words still counts,
    // so `return x` never matches `returnx` and "a b" never matches "ab".
    { name: 'inner whitespace', line: (line) => normalizeQuotes(line.replace(/\r$/, '').trim()).replace(/[ \t]+/g, ' ').replace(/ ?([^\w ]) ?/g, '$1') }
  ];
}

function findLineBlockMatches(fileLines, needleLines, normalize) {
  const target = needleLines.map(normalize);
  const normalized = fileLines.map(normalize);
  const matches = [];
  outer: for (let start = 0; start + target.length <= normalized.length; start++) {
    for (let offset = 0; offset < target.length; offset++) {
      if (normalized[start + offset] !== target[offset]) continue outer;
    }
    matches.push(start);
    if (matches.length > 1) break;
  }
  return matches;
}

const leadOf = (line) => (line.match(/^[ \t]*/) || [''])[0];

// Smallest indentation step in a block, e.g. '\t', '  ' or '    '.
function indentUnit(lines) {
  const leads = lines.filter((line) => line.trim()).map(leadOf);
  if (leads.some((lead) => lead.includes('\t'))) return '\t';
  let unit = 0;
  const widths = [...new Set(leads.map((lead) => lead.length))].sort((a, b) => a - b);
  for (let i = 0; i < widths.length; i++) {
    const step = i === 0 ? widths[0] : widths[i] - widths[i - 1];
    if (step > 0 && (!unit || step < unit)) unit = step;
  }
  return unit ? ' '.repeat(unit) : '';
}

// The model's old_string matched the file only after ignoring indentation, so its
// new_string is indented the way the model imagined the file. Translate each
// replacement line into the file's real indentation: reuse the file's exact
// leading whitespace for indentation levels seen in the matched block, and
// convert levels the block never used between the model's indent unit and the
// file's (for example four spaces to a tab).
function reindent(newLines, oldNeedleLines, actualLines) {
  const map = new Map();
  oldNeedleLines.forEach((line, index) => {
    const actual = actualLines[index];
    if (!line.trim() || actual === undefined || !actual.trim()) return;
    const from = leadOf(line);
    if (!map.has(from)) map.set(from, leadOf(actual));
  });
  const fromUnit = indentUnit(oldNeedleLines);
  const toUnit = indentUnit(actualLines);
  const firstOld = oldNeedleLines.find((line) => line.trim());
  const firstActual = actualLines.find((line) => line.trim());
  const base = { from: firstOld === undefined ? '' : leadOf(firstOld), to: firstActual === undefined ? '' : leadOf(firstActual) };
  return newLines.map((line) => {
    if (!line.trim()) return line;
    const lead = leadOf(line);
    const body = line.slice(lead.length);
    if (map.has(lead)) return map.get(lead) + body;
    if (fromUnit && toUnit && fromUnit !== toUnit && !lead.includes('\t') === (fromUnit !== '\t')) {
      const levels = fromUnit === '\t' ? lead.split('\t').length - 1 : Math.round(lead.length / fromUnit.length);
      if ((fromUnit === '\t' ? '\t'.repeat(levels) : fromUnit.repeat(levels)) === lead) return toUnit.repeat(levels) + body;
    }
    if (lead.startsWith(base.from) && base.from !== base.to) return base.to + lead.slice(base.from.length) + body;
    return line;
  });
}

// Lines the model reproduced unchanged from old_string are copied from the file
// verbatim, so relaxed matches never rewrite trailing whitespace, indentation or
// typography on lines the edit did not touch.
function keepUntouchedLines(replacement, rawReplacement, needleLines, actual) {
  const strip = (line) => line.replace(/\r$/, '').replace(/[ \t]+$/, '');
  const byNeedle = new Map();
  needleLines.forEach((line, index) => {
    const key = strip(line);
    if (!key.trim() || actual[index] === undefined) return;
    if (!byNeedle.has(key)) byNeedle.set(key, actual[index]);
    else if (byNeedle.get(key) !== actual[index]) byNeedle.set(key, null);
  });
  return replacement.map((line, index) => {
    const original = byNeedle.get(strip(rawReplacement[index]));
    return original === undefined || original === null ? line : original;
  });
}

// Keep the file's own spacing around the part of a line the edit changed:
// align the non-whitespace characters of the replacement and the file line,
// copy the file line through the common prefix and suffix, and splice in only
// the replacement's changed middle.
function restoreSpacing(replacementLine, actualLine) {
  if (replacementLine === undefined || actualLine === undefined) return replacementLine;
  const chars = (line) => [...line].map((ch, idx) => ({ ch, idx })).filter((c) => !/[ \t]/.test(c.ch));
  const r = chars(replacementLine);
  const a = chars(actualLine);
  let p = 0;
  while (p < r.length && p < a.length && r[p].ch === a[p].ch) p++;
  let s = 0;
  while (s < r.length - p && s < a.length - p && r[r.length - 1 - s].ch === a[a.length - 1 - s].ch) s++;
  if (!p && !s) return replacementLine;
  if (p === r.length && p === a.length) return actualLine;
  const lead = (line) => leadOf(line).length;
  const aStart = p ? a[p - 1].idx + 1 : lead(actualLine);
  const rStart = p ? r[p - 1].idx + 1 : lead(replacementLine);
  const aEnd = s ? a[a.length - s].idx : actualLine.replace(/[ \t]+$/, '').length;
  const rEnd = s ? r[r.length - s].idx : replacementLine.replace(/[ \t]+$/, '').length;
  const middle = rEnd > rStart ? replacementLine.slice(rStart, rEnd) : '';
  return actualLine.slice(0, aStart) + middle + actualLine.slice(Math.max(aEnd, aStart));
}

const TYPOGRAPHIC = /[\u2018\u2019\u201A\u201B\u2032\u201C\u201D\u201E\u201F\u2033\u2013\u2014\u00A0]/;

// The model typed ASCII quotes/dashes for text that uses typographic ones. Keep the
// file's characters wherever the replacement did not actually change the text:
// unchanged lines are copied from the file, and changed lines keep the file's
// characters in their common prefix and suffix. normalizeQuotes maps one
// character to one character, so positions line up.
function restoreLine(replacementLine, actualLine) {
  if (!TYPOGRAPHIC.test(actualLine)) return replacementLine;
  const a = normalizeQuotes(replacementLine);
  const b = normalizeQuotes(actualLine);
  if (a === b) return actualLine;
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return actualLine.slice(0, prefix) + replacementLine.slice(prefix, replacementLine.length - suffix) + actualLine.slice(actualLine.length - suffix);
}

// The opposite drift: the model typed curly quotes for code that uses straight
// ones (common when code was copied through a chat UI). Writing those curly
// quotes into source code breaks it, so map quote characters in the
// replacement back to ASCII. Dashes and other new typography are kept.
const CURLY_QUOTES = /[\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F]/;
function asciiQuotes(line) {
  return line.replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"');
}

function keepTypography(replacement, needleLines, actual) {
  if (!actual.some((line) => TYPOGRAPHIC.test(line))) {
    if (needleLines.some((line) => CURLY_QUOTES.test(line))) return replacement.map(asciiQuotes);
    return replacement;
  }
  const byNormalized = new Map();
  actual.forEach((line) => { const key = normalizeQuotes(line); if (!byNormalized.has(key)) byNormalized.set(key, line); });
  return replacement.map((line, index) => {
    const same = byNormalized.get(normalizeQuotes(line));
    if (same !== undefined) return same;
    return replacement.length === needleLines.length ? restoreLine(line, actual[index]) : line;
  });
}

/**
 * Try relaxed matching when the exact old_string was not found.
 * Returns { next, strategy, line } on a unique relaxed match, otherwise null.
 */
// A whole-file rewrite should not silently change a file's line endings or drop its
// byte-order mark: models emit LF and no BOM, so rewriting a CRLF (Windows) file
// would otherwise turn every line into a diff. Only consistent conventions are
// carried over; mixed files and content that already chose CRLF are left alone.
export function preserveFileConventions(previous, next) {
  if (typeof previous !== 'string' || typeof next !== 'string') return { content: next, kept: [] };
  let content = next;
  const kept = [];
  const crlf = (previous.match(/\r\n/g) || []).length;
  const bareLf = (previous.match(/(?<!\r)\n/g) || []).length;
  if (crlf > 0 && bareLf === 0 && !content.includes('\r\n') && content.includes('\n')) {
    content = content.replace(/(?<!\r)\n/g, '\r\n');
    kept.push('CRLF line endings');
  }
  if (previous.startsWith('\ufeff') && !content.startsWith('\ufeff')) {
    content = '\ufeff' + content;
    kept.push('byte-order mark');
  }
  return { content, kept };
}

export function relaxedReplace(current, oldString, newString) {
  if (!oldString.trim()) return null;
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const fileLines = current.split('\n');
  const needleLines = oldString.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  for (const strategy of lineNormalizers()) {
    const matches = findLineBlockMatches(fileLines, needleLines, strategy.line);
    if (matches.length !== 1) {
      if (matches.length > 1) return null; // ambiguous under relaxation: refuse
      continue;
    }
    const start = matches[0];
    const actual = fileLines.slice(start, start + needleLines.length).map((line) => line.replace(/\r$/, ''));
    const rawReplacement = newString.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    let replacement = rawReplacement;
    if (strategy.name === 'indentation' || strategy.name === 'inner whitespace') replacement = reindent(replacement, needleLines, actual);
    if (strategy.name === 'inner whitespace' && rawReplacement.length === needleLines.length) replacement = replacement.map((line, index) => restoreSpacing(line, actual[index]));
    if (strategy.name !== 'line endings and trailing whitespace') replacement = keepTypography(replacement, needleLines, actual);
    replacement = keepUntouchedLines(replacement, rawReplacement, needleLines, actual);
    const hadCr = /\r$/.test(fileLines[start + needleLines.length - 1] || '');
    const replacedLines = replacement.map((line, index) => (eol === '\r\n' && (index < replacement.length - 1 || hadCr) ? line + '\r' : line));
    const nextLines = [...fileLines.slice(0, start), ...replacedLines, ...fileLines.slice(start + needleLines.length)];
    return { next: nextLines.join('\n'), strategy: strategy.name, line: start + 1 };
  }
  return lineNumberedReplace(current, oldString, newString);
}

// The model copied read output with its line numbers ("     2\tconst b = 2;",
// "  2→const b", "2 | const b", "2: const b"). Only when every line of
// old_string carries consecutive numbers, and the file itself does not contain
// them, are the prefixes removed (also from new_string) and the edit retried.
const LINE_NUMBER_PREFIX = /^\s*(\d+)(?:\t|→|\u2192| \| |\| ?|: )/;
function stripLineNumbers(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const numbers = [];
  const body = [];
  for (const line of lines) {
    const m = LINE_NUMBER_PREFIX.exec(line);
    if (!m) return null;
    numbers.push(Number(m[1]));
    body.push(line.slice(m[0].length));
  }
  for (let i = 1; i < numbers.length; i++) if (numbers[i] !== numbers[i - 1] + 1) return null;
  return { text: body.join('\n'), first: numbers[0] };
}

function lineNumberedReplace(current, oldString, newString) {
  const old = stripLineNumbers(oldString);
  if (!old || !old.text.trim()) return null;
  // new_string may keep the numbers or drop them; strip them only if present on every line.
  const replacementLines = newString.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const numbered = replacementLines.every((line) => !line.trim() || LINE_NUMBER_PREFIX.test(line));
  const replacement = numbered ? replacementLines.map((line) => line.replace(LINE_NUMBER_PREFIX, '')).join('\n') : newString;
  let count = 0;
  for (let at = current.indexOf(old.text); at >= 0; at = current.indexOf(old.text, at + old.text.length)) count++;
  if (count > 1) return null;
  if (count === 1) {
    const next = current.replace(old.text, () => replacement);
    return { next, strategy: 'line-number prefixes from read output', line: current.slice(0, current.indexOf(old.text)).split('\n').length };
  }
  const relaxed = relaxedReplace(current, old.text, replacement);
  return relaxed ? { ...relaxed, strategy: 'line-number prefixes from read output and ' + relaxed.strategy } : null;
}

function similarity(a, b) {
  const x = a.trim();
  const y = b.trim();
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  const grams = (value) => {
    const set = new Map();
    for (let i = 0; i < value.length - 1; i++) {
      const gram = value.slice(i, i + 2);
      set.set(gram, (set.get(gram) || 0) + 1);
    }
    return set;
  };
  const gx = grams(x);
  const gy = grams(y);
  let overlap = 0;
  for (const [gram, count] of gx) overlap += Math.min(count, gy.get(gram) || 0);
  const total = Math.max(1, x.length - 1 + y.length - 1);
  return (2 * overlap) / total;
}

/** Describe the closest region of the file to old_string, for error messages. */
export function closestMatchHint(current, oldString, { maxLines = 12 } = {}) {
  const fileLines = current.replace(/\r\n/g, '\n').split('\n');
  const needleLines = oldString.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const span = Math.max(1, Math.min(needleLines.length, 60));
  if (fileLines.length > 20000) return '';
  const anchor = needleLines.find((line) => line.trim().length >= 4) || needleLines[0];
  let best = { score: 0, start: -1 };
  for (let start = 0; start + 1 <= fileLines.length; start++) {
    // cheap pre-filter on the anchor line, then score the whole block
    if (similarity(fileLines[start], anchor) < 0.35 && span > 1) {
      let found = false;
      for (let k = 1; k < span && start + k < fileLines.length; k++) {
        if (similarity(fileLines[start + k], anchor) >= 0.35) { found = true; break; }
      }
      if (!found) continue;
    }
    const block = fileLines.slice(start, start + span).join('\n');
    const score = similarity(block, needleLines.join('\n'));
    if (score > best.score) best = { score, start };
  }
  if (best.start < 0 || best.score < 0.5) return '';
  const shown = fileLines.slice(best.start, best.start + Math.min(span, maxLines));
  const width = String(best.start + shown.length).length;
  const excerpt = shown.map((line, index) => String(best.start + index + 1).padStart(width, ' ') + '| ' + line).join('\n');
  return 'Closest match (' + Math.round(best.score * 100) + '% similar) starts at line ' + (best.start + 1) + ':\n' + excerpt +
    (span > maxLines ? '\n…' : '') + '\nCopy old_string exactly from this text (without the line-number prefix).';
}

/**
 * Warning when a full rewrite turned existing lines with typographic quotes,
 * dashes or non-breaking spaces into ASCII copies of themselves.
 */
export function typographyWarning(previous, next, displayPath) {
  if (typeof previous !== 'string' || typeof next !== 'string' || !TYPOGRAPHIC.test(previous)) return '';
  const nextLines = new Set(next.split(/\r?\n/));
  let flattened = 0;
  let example = '';
  for (const line of previous.split(/\r?\n/)) {
    if (!TYPOGRAPHIC.test(line) || nextLines.has(line)) continue;
    const ascii = normalizeQuotes(line);
    if (ascii !== line && nextLines.has(ascii)) { flattened++; if (!example) example = line.trim().slice(0, 80); }
  }
  if (flattened < 1) return '';
  return 'Typography changed: ' + flattened + ' line(s) in ' + displayPath + ' lost their curly quotes, dashes or non-breaking spaces (for example: ' + example +
    '). Restore the original characters with edit_file unless the user asked for ASCII.';
}
