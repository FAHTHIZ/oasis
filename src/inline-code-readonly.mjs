// Recognises inline scripts that only read files and print, such as
//   node -e "const fs=require('fs'); ... console.log(totals)"
//   python3 -c "import csv; print(sum(...))"
// so the approval prompt does not call them HIGH RISK. Models reach for these
// one-liners for quick data questions, and a red "HIGH RISK" banner (with no
// "always allow" choice) on a script that sums a CSV trains people to approve
// without reading, which defeats the label for scripts that really are risky.
//
// This is an allowlist, not a detector. A script counts as read-only only when
// every module it loads is a known pure or read-only module, every file-system
// call is a read, and none of the escape hatches that could reach anything
// else (dynamic require/import, eval, bracket access with computed strings,
// process internals, subprocesses, network) appear anywhere in the text. Any
// doubt means "not read-only", and the command keeps the HIGH RISK prompt.

const NODE_MODULES = new Set(['fs', 'path', 'os', 'util', 'readline', 'assert', 'url', 'querystring', 'string_decoder', 'buffer', 'events', 'zlib', 'crypto']);
const NODE_FS_READS = new Set(['readFileSync', 'readFile', 'readdirSync', 'readdir', 'existsSync', 'statSync', 'stat', 'lstatSync', 'lstat', 'accessSync', 'createReadStream', 'realpathSync', 'promises']);
const NODE_FS_PROMISE_READS = new Set(['readFile', 'readdir', 'stat', 'lstat', 'access', 'realpath']);
// Words that reach past reading and printing. Matched as whole identifiers.
const NODE_FORBIDDEN = /\b(?:child_process|spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|eval|Function|import|globalThis|global|Reflect|Proxy|constructor|prototype|__proto__|mainModule|module|binding|dlopen|_linkedBinding|vm|worker_threads|Worker|http|https|http2|net|tls|dgram|dns|fetch|WebSocket|XMLHttpRequest|inspector|cluster|v8|wasi|WebAssembly|setuid|setgid|kill|chdir|umask|writev|writevSync|ftruncate|fchmod|fchown|lchmod|lchown|lutimes|futimes|setPriority|writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|writeSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|rename|renameSync|copyFile|copyFileSync|cp|cpSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|chmod|chmodSync|chown|chownSync|symlink|symlinkSync|link|linkSync|truncate|truncateSync|utimes|utimesSync|open|openSync|watch|watchFile|env)\b/;

const PY_MODULES = new Set(['csv', 'json', 'math', 'statistics', 'collections', 'itertools', 'functools', 're', 'datetime', 'decimal', 'fractions', 'string', 'textwrap', 'pprint', 'operator', 'heapq', 'bisect', 'random', 'time', 'calendar', 'unicodedata', 'difflib', 'hashlib', 'base64', 'binascii', 'struct', 'array', 'copy', 'dataclasses', 'enum', 'typing', 'numbers', 'zoneinfo']);
const PY_FORBIDDEN = /\b(?:__\w+__|__import__|eval|exec|compile|getattr|setattr|delattr|globals|locals|vars|breakpoint|input|help|memoryview|os|sys|subprocess|shutil|socket|pathlib|urllib|requests|http|ftplib|smtplib|telnetlib|ctypes|importlib|pickle|marshal|shelve|tempfile|glob|signal|threading|multiprocessing|asyncio|builtins|writelines|unlink|rmdir|rename|system|popen|spawn|fork|kill|chmod|chown|mkdir|makedirs)\b/;
// open(path) or open(path, 'r'/'rb'/'rt') with an optional encoding/newline.
const PY_OPEN_READ = /\bopen\(\s*(?:'[^'\\]*'|"[^"\\]*"|[A-Za-z_][\w.]*)\s*(?:,\s*(?:mode\s*=\s*)?(['"])r[bt]?\1\s*)?(?:,\s*(?:encoding|newline|errors)\s*=\s*(?:'[^']*'|"[^"]*"|None)\s*)*\)/g;

// Bracket access whose key is a string or computed (`fs['write'+'File']`) can
// spell any forbidden name, so it is refused outright. Plain index access such
// as `row[2]`, `a[i]` and `totals[region]` stays allowed.
const COMPUTED_ACCESS = /\[[^\]]*['"`+][^\]]*\]/;

function nodeReadOnly(code) {
  if (NODE_FORBIDDEN.test(code) || COMPUTED_ACCESS.test(code)) return false;
  if (/\\[ux]/.test(code)) return false; // escapes can hide a name inside a string
  // Every require() names a literal, allowed module.
  const requireWords = [...code.matchAll(/\brequire\b/g)].length;
  const requires = [...code.matchAll(/\brequire\(\s*(['"])(?:node:)?([\w/]+)\1\s*\)/g)];
  if (requireWords !== requires.length) return false;
  if (requires.some((m) => !NODE_MODULES.has(m[2].split('/')[0]))) return false;
  // Each require() is either bound to a name or used as require('x').prop.
  // A handle may then only appear as handle.prop: it cannot be enumerated
  // (Object.values(fs)), passed to a function or indexed (fs[k]), any of which
  // could reach a write method without spelling its name.
  const handles = new Map(); // name -> module
  let rest = code;
  const bind = /\b(?:const|let|var)\s+(\w+|\{[^}]*\})\s*=\s*require\(\s*(['"])(?:node:)?([\w/]+)\2\s*\)(\.\w+)?/g;
  for (const m of code.matchAll(bind)) {
    const mod = m[3].split('/')[0] + (m[4] ? m[4] : '');
    if (m[1].startsWith('{')) {
      for (const part of m[1].slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean)) {
        const [prop] = part.split(':').map((x) => x.trim());
        if ((mod === 'fs' && !NODE_FS_READS.has(prop)) || (mod === 'fs.promises' && !NODE_FS_PROMISE_READS.has(prop)) || prop.startsWith('...')) return false;
      }
    } else handles.set(m[1], mod);
    rest = rest.replace(m[0], ' ');
  }
  // Remaining require() calls must be followed directly by a property.
  for (const m of rest.matchAll(/\brequire\(\s*(['"])(?:node:)?([\w/]+)\1\s*\)(\.(\w+)(?:\.(\w+))?)?/g)) {
    if (!m[3]) return false;
    if (m[2] === 'fs' && (!NODE_FS_READS.has(m[4]) || (m[4] === 'promises' && m[5] && !NODE_FS_PROMISE_READS.has(m[5])))) return false;
  }
  handles.set('process', 'process');
  for (const [name, mod] of handles) {
    const uses = [...rest.matchAll(new RegExp('(?<![\\w.$])' + name.replace(/\$/g, '\\$') + '\\b(\\s*\\.\\s*(\\w+)(?:\\s*\\.\\s*(\\w+))?)?', 'g'))];
    for (const u of uses) {
      if (!u[1]) return false; // bare handle: passed, enumerated or indexed
      const prop = u[2];
      if (mod === 'fs' && (!NODE_FS_READS.has(prop) || (prop === 'promises' && u[3] && !NODE_FS_PROMISE_READS.has(u[3])))) return false;
      if (mod === 'fs.promises' && !NODE_FS_PROMISE_READS.has(prop)) return false;
      if (mod === 'process') {
        if (!['argv', 'stdout', 'stderr', 'cwd', 'exitCode', 'platform', 'version'].includes(prop)) return false;
        if ((prop === 'stdout' || prop === 'stderr') && u[3] !== 'write') return false;
      }
    }
  }
  return true;
}

function pythonReadOnly(code) {
  // `sys.stdout.write` and `print(...)` both print; only print is allowed.
  const withoutOpens = code.replace(PY_OPEN_READ, 'READ_OPEN');
  if (/\bopen\b/.test(withoutOpens)) return false; // an open() with a write mode or an unusual form
  if (PY_FORBIDDEN.test(withoutOpens) || /\\[uxN0-7]/.test(withoutOpens)) return false;
  for (const m of withoutOpens.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.\s,]+?)(?:\s+as\s+\w+)?\s*(?:;|$))/gm)) {
    const names = (m[1] || m[2] || '').split(',').map((n) => n.trim().split(/\s+/)[0].split('.')[0]).filter(Boolean);
    if (names.some((n) => !PY_MODULES.has(n))) return false;
  }
  // `import x` can also follow a semicolon on one line.
  for (const m of withoutOpens.matchAll(/(?:^|;)\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.,\s]+?))(?=\s*(?:;|$|\bas\b))/gm)) {
    const names = (m[1] || m[2] || '').split(',').map((n) => n.trim().split(/\s+/)[0].split('.')[0]).filter(Boolean);
    if (names.some((n) => !PY_MODULES.has(n))) return false;
  }
  return true;
}

// base: the interpreter name (node, python3, ...). args: its arguments.
// True only for `<interpreter> <code-flag> <code> [plain file arguments]`.
export function isReadOnlyInlineScript(base, args = []) {
  const list = args.map(String);
  const isNode = base === 'node' || base === 'nodejs';
  const isPython = /^python(?:\d+(?:\.\d+)?)?$/.test(base) || base === 'py';
  if (!isNode && !isPython) return false;
  const flags = isNode ? ['-e', '--eval', '-p', '--print', '-pe', '-ep'] : ['-c'];
  if (list.length < 2 || !flags.includes(list[0])) return false;
  if (list.slice(2).some((a) => a.startsWith('-'))) return false;
  const code = list[1];
  if (!code || code.length > 4000) return false;
  return isNode ? nodeReadOnly(code) : pythonReadOnly(code);
}
