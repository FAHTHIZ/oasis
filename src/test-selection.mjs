// Test selection: map changed source files to the tests likely to exercise them.
//
// Uses two signals:
//  1. Naming conventions: foo.js -> foo.test.js, __tests__/foo.js, foo.spec.ts,
//     test_foo.py, foo_test.go.
//  2. Import-graph closure: if a changed file is imported (transitively) by a
//     test file, that test is selected.
// Falls back to returning all test files when no mapping is found, so the
// caller never silently skips coverage.
import path from 'node:path';

const TEST_PATTERNS = [
  (file) => file.replace(/\.(js|mjs|cjs|jsx|ts|tsx)$/, '.test.$1'),
  (file) => file.replace(/\.(js|mjs|cjs|jsx|ts|tsx)$/, '.spec.$1'),
  (file) => file.replace(/\.(js|mjs|cjs|jsx|ts|tsx)$/, '.test.$1').replace(/([^/]+)$/, '__tests__/$1'),
  (file) => file.replace(/\.(py)$/, '_test.py'),
  (file) => file.replace(/\.(go)$/, '_test.go')
];

function isTestFile(file) {
  return /\.(test|spec)\.[a-z]+$/.test(file) || /(^|\/)__(tests|tests__)\//.test(file) || /_test\.(py|go)$/.test(file);
}

// Extract relative import specifiers from a JS/TS file (best effort).
function importSpecifiers(text) {
  const out = [];
  for (const match of String(text || '').matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g)) {
    if (match[1].startsWith('.')) out.push(match[1]);
  }
  return out;
}

// Resolve a relative import to a concrete file path, trying common extensions.
function resolveImport(fromFile, spec, allFiles) {
  const dir = path.posix.dirname(fromFile);
  const joined = path.posix.normalize(path.posix.join(dir, spec));
  const extensions = ['', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '/index.js', '/index.ts'];
  for (const ext of extensions) {
    const candidate = joined + ext;
    if (allFiles.has(candidate)) return candidate;
  }
  return null;
}

// Build a reverse import graph: target file -> set of files that import it.
function buildReverseGraph(allFiles, fileContents) {
  const reverse = new Map();
  for (const [file, text] of fileContents) {
    for (const spec of importSpecifiers(text)) {
      const resolved = resolveImport(file, spec, allFiles);
      if (resolved && resolved !== file) {
        if (!reverse.has(resolved)) reverse.set(resolved, new Set());
        reverse.get(resolved).add(file);
      }
    }
  }
  return reverse;
}

// Select test files for a set of changed source files.
// Returns { selected: string[], strategy: 'conventions'|'import-graph'|'all' }.
export function selectTests(changedFiles, allTestFiles, options = {}) {
  const changed = Array.isArray(changedFiles) ? changedFiles : [];
  const tests = Array.isArray(allTestFiles) ? allTestFiles : [];
  if (!changed.length || !tests.length) return { selected: tests.slice(), strategy: 'all' };

  const selected = new Set();

  // 1. Naming conventions.
  for (const changedFile of changed) {
    for (const pattern of TEST_PATTERNS) {
      const candidate = pattern(changedFile);
      if (tests.includes(candidate)) selected.add(candidate);
    }
  }

  // 2. Import-graph closure (only when file contents are provided).
  let strategy = selected.size ? 'conventions' : 'all';
  if (options.fileContents && options.fileContents instanceof Map) {
    const allFiles = new Set([...options.fileContents.keys()]);
    const reverse = buildReverseGraph(allFiles, options.fileContents);
    const queue = [...changed];
    const seen = new Set(queue);
    while (queue.length) {
      const current = queue.shift();
      const importers = reverse.get(current) || [];
      for (const importer of importers) {
        if (isTestFile(importer)) selected.add(importer);
        if (!seen.has(importer)) { seen.add(importer); queue.push(importer); }
      }
    }
    if (selected.size) strategy = 'import-graph';
  }

  if (!selected.size) return { selected: tests.slice(), strategy: 'all' };
  return { selected: [...selected].sort(), strategy };
}
