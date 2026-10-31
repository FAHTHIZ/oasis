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
    { name: 'indentation', line: (line) => normalizeQuotes(line.replace(/\r$/, '').trim()) }
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

function reindent(newLines, oldNeedleLines, actualLines) {
  const lead = (line) => (line.match(/^[ \t]*/) || [''])[0];
  const firstOld = oldNeedleLines.find((line) => line.trim());
  const firstActual = actualLines.find((line) => line.trim());
  if (firstOld === undefined || firstActual === undefined) return newLines;
  const from = lead(firstOld);
  const to = lead(firstActual);
  if (from === to) return newLines;
  return newLines.map((line) => {
    if (!line.trim()) return line;
    if (line.startsWith(from)) return to + line.slice(from.length);
    return line;
  });
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

function keepTypography(replacement, needleLines, actual) {
  if (!actual.some((line) => TYPOGRAPHIC.test(line))) return replacement;
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
    let replacement = newString.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    if (strategy.name === 'indentation') replacement = reindent(replacement, needleLines, actual);
    if (strategy.name !== 'line endings and trailing whitespace') replacement = keepTypography(replacement, needleLines, actual);
    const hadCr = /\r$/.test(fileLines[start + needleLines.length - 1] || '');
    const replacedLines = replacement.map((line, index) => (eol === '\r\n' && (index < replacement.length - 1 || hadCr) ? line + '\r' : line));
    const nextLines = [...fileLines.slice(0, start), ...replacedLines, ...fileLines.slice(start + needleLines.length)];
    return { next: nextLines.join('\n'), strategy: strategy.name, line: start + 1 };
  }
  return null;
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
