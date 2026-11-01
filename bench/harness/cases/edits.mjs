// Edit-application corpus.
//
// Each case is a file, an `old_string`/`new_string` pair as a model sent it,
// and the file a careful human would expect afterwards. `expect: null` means
// the edit is ambiguous or wrong and the only correct outcome is to refuse
// without touching the file.
//
// The drift patterns are the ones models produce most often when they
// reproduce code from memory instead of copying it byte-for-byte: lost
// trailing whitespace, LF vs CRLF, tabs vs spaces, a different indentation
// depth, and curly vs straight quotes.

const fn = 'function add(a, b) {\n  return a + b;\n}\n';

export const cases = [
  // ---- exact matches (every harness should pass these) -----------------
  { id: 'exact-single-line', file: fn, old: '  return a + b;', new: '  return a + b + 0;', expect: 'function add(a, b) {\n  return a + b + 0;\n}\n' },
  { id: 'exact-block', file: fn, old: 'function add(a, b) {\n  return a + b;\n}', new: 'function add(a, b) {\n  return Number(a) + Number(b);\n}', expect: 'function add(a, b) {\n  return Number(a) + Number(b);\n}\n' },

  // ---- whitespace drift --------------------------------------------------
  { id: 'drift-trailing-space-in-file', file: 'const a = 1;   \nconst b = 2;\n', old: 'const a = 1;\nconst b = 2;', new: 'const a = 10;\nconst b = 2;', expect: 'const a = 10;\nconst b = 2;\n' },
  { id: 'drift-trailing-space-in-old', file: 'const a = 1;\nconst b = 2;\n', old: 'const a = 1;  \nconst b = 2;', new: 'const a = 10;\nconst b = 2;', expect: 'const a = 10;\nconst b = 2;\n' },
  { id: 'drift-crlf-file', file: 'line one\r\nline two\r\nline three\r\n', old: 'line one\nline two', new: 'line ONE\nline two', expect: 'line ONE\r\nline two\r\nline three\r\n' },
  { id: 'drift-crlf-old', file: 'line one\nline two\nline three\n', old: 'line one\r\nline two', new: 'line ONE\r\nline two', expect: 'line ONE\nline two\nline three\n' },
  { id: 'drift-indent-shallower', file: 'class A {\n    run() {\n        return 1;\n    }\n}\n', old: 'run() {\n    return 1;\n}', new: 'run() {\n    return 2;\n}', expect: 'class A {\n    run() {\n        return 2;\n    }\n}\n' },
  { id: 'drift-indent-deeper', file: 'if (x) {\n  go();\n  stop();\n}\n', old: '    go();\n    stop();', new: '    go();\n    pause();\n    stop();', expect: 'if (x) {\n  go();\n  pause();\n  stop();\n}\n' },
  { id: 'drift-tabs-vs-spaces', file: 'function f() {\n\tif (a) {\n\t\treturn b;\n\t}\n}\n', old: '  if (a) {\n    return b;\n  }', new: '  if (a) {\n    return c;\n  }', expect: 'function f() {\n\tif (a) {\n\t\treturn c;\n\t}\n}\n' },
  { id: 'drift-python-indent', file: 'def f(x):\n    if x:\n        return 1\n    return 0\n', old: 'if x:\n    return 1', new: 'if x:\n    return 2', expect: 'def f(x):\n    if x:\n        return 2\n    return 0\n' },

  // ---- typography drift --------------------------------------------------
  { id: 'drift-curly-quotes-in-old', file: 'const msg = "don\'t panic";\n', old: 'const msg = \u201cdon\u2019t panic\u201d;', new: 'const msg = \u201cdon\u2019t worry\u201d;', expect: 'const msg = "don\'t worry";\n' },
  { id: 'drift-curly-quotes-in-file', file: 'title: \u201cHello\u201d\nbody: x\n', old: 'title: "Hello"', new: 'title: "Hi"', expect: 'title: \u201cHi\u201d\nbody: x\n' },

  // ---- preservation of file properties ------------------------------------
  { id: 'preserve-bom', file: '\uFEFFname = "a"\nversion = "1"\n', old: 'version = "1"', new: 'version = "2"', expect: '\uFEFFname = "a"\nversion = "2"\n' },
  { id: 'preserve-no-final-newline', file: 'a\nb', old: 'b', new: 'c', expect: 'a\nc' },

  // ---- must refuse ---------------------------------------------------------
  { id: 'refuse-ambiguous-exact', file: 'x = 1\ny = 2\nx = 1\n', old: 'x = 1', new: 'x = 3', expect: null },
  { id: 'refuse-ambiguous-relaxed', file: 'if a:\n    go()\nif b:\n  go()\n', old: 'go()', new: 'stop()', expect: null },
  { id: 'refuse-ambiguous-indent', file: '  return 1;\n    return 1;\n', old: 'return 1;', new: 'return 2;', expect: null },
  { id: 'refuse-not-present', file: fn, old: 'return a - b;', new: 'return a * b;', expect: null },
  { id: 'refuse-wrong-token', file: 'const limit = 10;\n', old: 'const limt = 10;', new: 'const limit = 20;', expect: null }
];

// Baseline: exact, unique byte-for-byte match. This is the documented
// contract of the edit tool in most coding agents ("old_string must match
// the file exactly"), so it stands in for a harness without relaxed matching.
export function exactReplace(file, oldString, newString) {
  const first = file.indexOf(oldString);
  if (first < 0 || file.indexOf(oldString, first + oldString.length) >= 0) return null;
  return file.slice(0, first) + newString + file.slice(first + oldString.length);
}

// Held-out cases (see tool-calls.mjs): never used to tune the runtime.
export const heldout = [
  { id: 'h-yaml-indent', file: 'jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n', old: 'steps:\n  - run: npm test', new: 'steps:\n  - run: npm ci\n  - run: npm test', expect: 'jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n      - run: npm test\n' },
  { id: 'h-go-tabs', file: 'func main() {\n\tfmt.Println("a")\n}\n', old: '    fmt.Println("a")', new: '    fmt.Println("b")', expect: 'func main() {\n\tfmt.Println("b")\n}\n' },
  { id: 'h-crlf-trailing-ws', file: 'a = 1 \r\nb = 2\r\n', old: 'a = 1\nb = 2', new: 'a = 1\nb = 3', expect: 'a = 1 \r\nb = 3\r\n' },
  { id: 'h-markdown-curly', file: 'He said \u201cship it\u201d.\nDone.\n', old: 'He said "ship it".', new: 'He said "ship it today".', expect: 'He said \u201cship it today\u201d.\nDone.\n' },
  { id: 'h-em-dash', file: 'Note \u2014 read first.\n', old: 'Note - read first.', new: 'Note - read this first.', expect: 'Note \u2014 read this first.\n' },
  { id: 'h-blank-line-drift', file: 'a();\n\nb();\n', old: 'a();\n  \nb();', new: 'a();\n\nc();', expect: 'a();\n\nc();\n' },
  { id: 'h-exact-with-crlf', file: 'x\r\ny\r\n', old: 'x\r\ny', new: 'x\r\nz', expect: 'x\r\nz\r\n' },
  { id: 'h-refuse-near-miss', file: 'const timeout = 30;\n', old: 'const timeout = 60;', new: 'const timeout = 90;', expect: null },
  { id: 'h-refuse-two-indented', file: 'def a():\n    return 1\n\ndef b():\n        return 1\n', old: 'return 1', new: 'return 2', expect: null },
  { id: 'h-refuse-partial-block', file: 'one\ntwo\nthree\n', old: 'one\nTWO\nthree', new: 'one\n2\nthree', expect: null }
];
