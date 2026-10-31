// Detects edits that weaken a test suite instead of fixing code: newly skipped
// or focused tests, removed test cases, and removed assertions. Runs against
// `git diff HEAD` for the files the agent changed, so pre-existing user edits
// in other files are not attributed to the agent.
import { execFile } from 'node:child_process';

const TEST_PATH = [
  /(^|\/)(tests?|__tests__|specs?|testing)\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /(_test|_spec)\.(go|py|rb|exs?)$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /(Test|Tests|Spec)\.(java|kt|scala|cs|swift|php)$/
];

export function isTestPath(file) {
  const normalized = String(file || '').replace(/\\/g, '/');
  return TEST_PATH.some((pattern) => pattern.test(normalized));
}

const SKIP_PATTERNS = [
  [/\b(?:it|test|describe|context|suite)\.(?:skip|todo)\s*\(/, 'skipped a test'],
  [/\b(?:it|test|describe)\.only\s*\(|\bf(?:it|describe)\s*\(/, 'focused a test with .only (other tests stop running)'],
  [/\bx(?:it|describe|test)\s*\(/, 'skipped a test'],
  [/\{\s*skip\s*:\s*(?:true|['"`])|\btest\.fixme\s*\(/, 'skipped a test'],
  [/@pytest\.mark\.(?:skip|xfail)\b|@unittest\.skip|\bpytest\.skip\s*\(|\bself\.skipTest\s*\(/, 'skipped a test'],
  [/\bt\.Skip(?:Now|f)?\s*\(/, 'skipped a test'],
  [/#\[ignore\]/, 'ignored a test'],
  [/@(?:Disabled|Ignore)\b/, 'disabled a test'],
  [/^\s*(?:skip|pending)(?:\s+['"]|\s*\(\s*['"]|\s*$)/, 'skipped a test']
];
const TEST_DECL = /^\s*(?:(?:it|test|specify)\s*\(|def\s+test_\w*\s*\(|func\s+Test\w*\s*\(|#\[test\]|@Test\b|fn\s+test_\w*\s*\()/;
const ASSERTION = /\b(?:assert\w*|expect|should|t\.(?:Error|Fatal)f?|require\.\w+)\s*[(.]|^\s*assert\b/;

/** Analyze unified diff text (from `git diff -U0`). Returns [{ file, reason, line? }]. */
export function analyzeTestDiff(diffText) {
  const findings = [];
  const files = new Map();
  let current = null;
  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('diff --git ')) { current = null; continue; }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).replace(/^b\//, '');
      if (target === '/dev/null') continue;
      current = { file: target, added: [], removed: [], deleted: false };
      files.set(target, current);
      continue;
    }
    if (line.startsWith('--- ')) {
      const source = line.slice(4).replace(/^a\//, '');
      if (source !== '/dev/null') current = { file: source, added: [], removed: [], deleted: true, pending: true };
      continue;
    }
    if (!current) continue;
    if (current.pending) { current.pending = false; files.set(current.file, current); }
    if (line.startsWith('+') && !line.startsWith('+++')) { current.deleted = false; current.added.push(line.slice(1)); }
    else if (line.startsWith('-') && !line.startsWith('---')) current.removed.push(line.slice(1));
  }
  for (const entry of files.values()) {
    if (!isTestPath(entry.file)) continue;
    if (entry.deleted && entry.removed.length && !entry.added.length && entry.removed.some((line) => TEST_DECL.test(line))) {
      findings.push({ file: entry.file, reason: 'deleted a test file with ' + entry.removed.filter((line) => TEST_DECL.test(line)).length + ' test(s)' });
      continue;
    }
    const removedSkips = entry.removed.join('\n');
    for (const [pattern, reason] of SKIP_PATTERNS) {
      const hit = entry.added.find((line) => pattern.test(line));
      if (hit && !pattern.test(removedSkips)) { findings.push({ file: entry.file, reason, line: hit.trim().slice(0, 160) }); break; }
    }
    const declDelta = entry.removed.filter((line) => TEST_DECL.test(line)).length - entry.added.filter((line) => TEST_DECL.test(line)).length;
    if (declDelta > 0) findings.push({ file: entry.file, reason: 'removed ' + declDelta + ' test case(s)' });
    const assertDelta = entry.removed.filter((line) => ASSERTION.test(line)).length - entry.added.filter((line) => ASSERTION.test(line)).length;
    if (assertDelta > 0 && declDelta <= 0) findings.push({ file: entry.file, reason: 'removed ' + assertDelta + ' assertion(s)' });
  }
  return findings;
}

/** Check the given changed paths against HEAD. Resolves [] outside Git or when nothing is weakened. */
export function detectTestTampering(root, paths, { timeoutMs = 15000 } = {}) {
  const tests = [...new Set(paths || [])].filter(isTestPath);
  if (!tests.length) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('git', ['diff', '--no-color', '--no-ext-diff', '-U0', 'HEAD', '--', ...tests], { cwd: root, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) return resolve([]);
      resolve(analyzeTestDiff(stdout));
    });
  });
}

export function formatTestTampering(findings) {
  return findings.map((item) => item.file + ': ' + item.reason + (item.line ? ' (`' + item.line + '`)' : '')).join('; ');
}
