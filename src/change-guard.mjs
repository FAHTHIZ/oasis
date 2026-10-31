// Change guard: catches common destructive edit failure modes reported by
// users of AI coding agents before they silently land in a workspace.
//
// 1. Elision placeholders ("// ... rest of the code unchanged") that replace
//    real code. Models emit these when they abbreviate a full-file rewrite,
//    and the result deletes everything the placeholder stood for.
// 2. Large silent shrinkage of an existing file, reported back to the model
//    so it must notice and justify (or undo) the removal.
// 3. Fix circling: a write that restores a file to an earlier state from the
//    same session (A -> B -> A), a strong signal of looping between fixes.

import { createHash } from 'node:crypto';

const ELISION_PATTERNS = [
  /^\s*(?:\/\/|#|--|;|\/\*+|<!--|\*)\s*\.{3}\s*(?:the\s+)?(?:rest|remaining|existing|other|previous|unchanged|same|original)\b[^\n]*$/im,
  /^\s*(?:\/\/|#|--|;|\/\*+|<!--|\*)\s*(?:the\s+)?(?:rest of (?:the )?(?:file|code|function|class|implementation|component|module)|existing code|previous code|remaining code|other (?:methods|functions|code))\b[^\n]*(?:unchanged|here|remains?|stays?|same|omitted|as before|\.{3})[^\n]*$/im,
  /^\s*(?:\/\/|#|--|;|\/\*+|<!--|\*)\s*\.{3}\s*(?:code|implementation)?\s*(?:unchanged|omitted|truncated|elided)\b[^\n]*$/im,
  /^\s*(?:\/\/|#|\/\*+)\s*\[?\s*\.{3}\s*(?:keep|leave) (?:the )?(?:rest|existing|everything else)\b[^\n]*$/im
];

export const SHRINK_MIN_LINES = 40;
export const SHRINK_RATIO = 0.5;

function lineCount(text) {
  if (!text) return 0;
  return text.split('\n').length;
}

export function findElisionPlaceholder(text) {
  const value = String(text || '');
  for (const pattern of ELISION_PATTERNS) {
    const match = value.match(pattern);
    if (match) return match[0].trim().slice(0, 160);
  }
  return '';
}

// Throws when new text introduces an elision placeholder that was not already
// present in the previous text. Returns nothing on success.
export function assertNoNewElision(previousText, nextText, displayPath) {
  const marker = findElisionPlaceholder(nextText);
  if (!marker) return;
  if (previousText && String(previousText).includes(marker)) return;
  throw new Error(
    'Refusing to write ' + displayPath + ': the new content contains the placeholder "' + marker + '", ' +
    'which would replace real code with a comment and delete it. Write the complete content, or use ' +
    'edit_file to change only the specific section. If this text is genuinely intended, reword it so it is ' +
    'not an elision comment.'
  );
}

// Returns a warning string when a rewrite removes most of an existing file.
export function shrinkWarning(previousText, nextText, displayPath) {
  const before = lineCount(previousText);
  const after = lineCount(nextText);
  if (before < SHRINK_MIN_LINES || after >= before) return '';
  const removed = before - after;
  if (removed / before < SHRINK_RATIO) return '';
  return 'This change shrank ' + displayPath + ' from ' + before + ' to ' + after + ' lines (' +
    Math.round((removed / before) * 100) + '% removed). Confirm every removed line was intentional before ' +
    'reporting the task done; if not, restore it with the automatic backup (/rewind or oasis restore).';
}

function hashText(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

// Tracks content history per path on a session-like holder object and returns
// a warning when the new content matches an earlier, non-adjacent version.
export function recordAndDetectCircling(holder, absolutePath, previousText, nextText, displayPath) {
  if (!holder || typeof holder !== 'object') return '';
  const store = holder.changeGuardHistory instanceof Map ? holder.changeGuardHistory : (holder.changeGuardHistory = new Map());
  let history = store.get(absolutePath);
  if (!history) {
    history = [];
    store.set(absolutePath, history);
  }
  const previousHash = previousText === null || previousText === undefined ? null : hashText(previousText);
  if (previousHash && history[history.length - 1] !== previousHash) history.push(previousHash);
  const nextHash = hashText(nextText);
  const prior = history.slice(0, -1);
  const earlier = prior.lastIndexOf(nextHash);
  const occurrences = prior.filter((hash) => hash === nextHash).length;
  history.push(nextHash);
  if (history.length > 50) history.splice(0, history.length - 50);
  if (earlier < 0) return '';
  const stepsBack = prior.length - earlier;
  // A single undo (A -> B -> A) is a legitimate revert; flag only real
  // oscillation: returning 2+ states back, or revisiting a state repeatedly.
  if (stepsBack < 2 && occurrences < 2) return '';
  return 'This change reverts ' + displayPath + ' to exactly the content it had ' + stepsBack +
    ' edit(s) ago in this session. You may be circling between the same fixes. Stop, re-read the actual error ' +
    'output, state a new hypothesis, and try a genuinely different approach (or ask the user) instead of repeating earlier attempts.';
}

// 4. Test tampering: an edit to a test file that removes assertions or adds
//    skips/trivial assertions — the classic "make the tests pass by weakening
//    the tests" failure. This warns (it does not block) because removing an
//    obsolete test can be legitimate; the model must say so to the user.
const TEST_PATH = /(^|[\\/])(tests?|__tests__|spec|specs)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb|exs?)$|(^|[\\/])test_[^\\/]+\.py$|Tests?\.(java|kt|cs|swift)$/i;
const ASSERTION = /\b(?:assert(?:_\w+|[A-Z]\w*)?|expect|should|t\.(?:equal|deepEqual|ok|is|true|false|throws|match|assert\w*)|require\.\w+|EXPECT_\w+|ASSERT_\w+|XCTAssert\w*)\s*[.(!]|^\s*assert\s+(?!True\b)\S/gm;
const SKIP = /\b(?:(?:it|test|describe|context)\.(?:skip|todo)|x(?:it|test|describe)|test\.fixme)\s*\(|@pytest\.mark\.(?:skip|xfail)\b|@unittest\.skip|\bt\.Skip(?:Now|f)?\(|@Disabled\b|@Ignore\b|\{\s*skip\s*:\s*true\s*\}|#\[ignore\]/g;
const TRIVIAL = /expect\(\s*(?:true|1)\s*\)\.(?:toBe|toEqual)\(\s*(?:true|1)\s*\)|\bassert\s+True\b|assert\.ok\(\s*true\s*\)|assert\(\s*true\s*\)|assertTrue\(\s*true\s*\)/g;

export function isTestPath(displayPath) {
  return TEST_PATH.test(String(displayPath || ''));
}

function countMatches(text, pattern) {
  const found = String(text || '').match(pattern);
  return found ? found.length : 0;
}

export function testTamperWarning(previousText, nextText, displayPath) {
  if (previousText === null || previousText === undefined || !isTestPath(displayPath)) return '';
  const removedAssertions = countMatches(previousText, ASSERTION) - countMatches(nextText, ASSERTION);
  const addedSkips = countMatches(nextText, SKIP) - countMatches(previousText, SKIP);
  const addedTrivial = countMatches(nextText, TRIVIAL) - countMatches(previousText, TRIVIAL);
  const signs = [];
  if (removedAssertions > 0) signs.push('removed ' + removedAssertions + ' assertion(s)');
  if (addedSkips > 0) signs.push('added ' + addedSkips + ' skip/disable marker(s)');
  if (addedTrivial > 0) signs.push('added ' + addedTrivial + ' always-true assertion(s)');
  if (!signs.length) return '';
  return 'Test-weakening check: this edit to ' + displayPath + ' ' + signs.join(', ') + '. Do not make failing tests pass by ' +
    'loosening or skipping them. If the test is correct, fix the code under test instead; if the test itself is genuinely wrong ' +
    'or obsolete, keep the change but tell the user explicitly which test you changed and why.';
}

export function combineWarnings(...warnings) {
  const list = warnings.filter(Boolean);
  return list.length ? list.join(' ') : '';
}
