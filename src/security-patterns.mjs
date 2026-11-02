// Per-edit security check: a fast pattern match over the lines an edit adds,
// with no model call. When new code uses a call that is a common source of
// vulnerabilities, the agent gets a short note naming the risk and the safer
// alternative, so it can fix the code in the same turn.
//
// Only added lines are checked (code that was already there is not
// re-reported), tests, fixtures and docs are skipped, and at most four notes
// are returned per edit. A note is advice, not a block: some of these calls
// are correct in context, and the agent is asked to keep them when they are.
import { findSecretsInText } from './secret-shield.mjs';

const JS = /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte|astro)$/i;
const PY = /\.py$/i;
const GO = /\.go$/i;
const RB = /\.(rb|erb)$/i;
const PHP = /\.php$/i;
const JAVA = /\.(java|kt|scala)$/i;
const C = /\.(c|cc|cpp|cxx|h|hpp)$/i;
const CS = /\.cs$/i;
const ANY_CODE = /\.(m?[jt]sx?|cjs|py|go|rb|php|java|kt|cs|rs|c|cc|cpp|h|hpp|swift|scala|sh|ya?ml|toml|json|env|ini|cfg|conf|tf)$/i;

const RULES = [
  [JS, /(?<![.\w$])eval\s*\(|\bnew\s+Function\s*\(/, 'dynamic code execution (eval / new Function)', 'parse data with JSON.parse or use a lookup table'],
  [JS, /(?:\b(?:child_process|childProcess|cp)\.|(?<![.\w$]))(?:exec|execSync)\s*\(\s*(?:`[^`]*\$\{|[^)]*\+\s*\w)/, 'a shell command built from variables (command injection)', 'use execFile/spawn with an argument array'],
  [JS, /\.(?:innerHTML|outerHTML)\s*\+?=|\binsertAdjacentHTML\s*\(|\bdocument\.write\s*\(/, 'raw HTML insertion (XSS)', 'set textContent, or sanitize with a vetted library such as DOMPurify'],
  [JS, /dangerouslySetInnerHTML/, 'dangerouslySetInnerHTML (XSS)', 'render text as children, or sanitize the HTML first'],
  [JS, /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/, 'TLS certificate verification turned off', 'keep verification on and add the CA certificate instead'],
  [JS, /\.(?:query|execute|raw)\s*\(\s*`[^`]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{/i, 'SQL built with string interpolation (SQL injection)', 'use parameterized queries / placeholders'],
  [JS, /\bcreateHash\s*\(\s*['"](?:md5|sha1)['"]\s*\)[^;\n]*(?:password|passwd|secret)/i, 'a fast hash (MD5/SHA-1) used for passwords', 'use bcrypt, scrypt or argon2'],
  [PY, /\bpickle\.loads?\s*\(|\bcPickle\.loads?\s*\(|\bshelve\.open\s*\(/, 'unpickling data (arbitrary code execution if the data is untrusted)', 'use json, or sign and verify the data before loading'],
  [PY, /\byaml\.load\s*\((?![^)]*Loader\s*=\s*(?:yaml\.)?(?:Safe|CSafe)Loader)/, 'yaml.load without SafeLoader (code execution)', 'use yaml.safe_load'],
  [PY, /(?<![\w.])(?:eval|exec)\s*\(/, 'dynamic code execution (eval / exec)', 'use ast.literal_eval or explicit parsing'],
  [PY, /\bsubprocess\.\w+\([^)]*shell\s*=\s*True|\bos\.(?:system|popen)\s*\(/, 'a shell command (command injection if any part is user-controlled)', 'call subprocess.run with an argument list and shell=False'],
  [PY, /\bverify\s*=\s*False\b/, 'TLS certificate verification turned off', 'keep verify=True and pass the CA bundle instead'],
  [PY, /\.execute\s*\(\s*(?:f["']|["'][^"']*["']\s*%\s*|["'][^"']*["']\s*\.format\()[^)]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i, 'SQL built with string formatting (SQL injection)', 'pass parameters separately: cursor.execute(sql, params)'],
  [PY, /\bhashlib\.(?:md5|sha1)\s*\([^)]*(?:password|passwd)/i, 'a fast hash (MD5/SHA-1) used for passwords', 'use bcrypt, scrypt, argon2 or hashlib.scrypt'],
  [GO, /InsecureSkipVerify\s*:\s*true/, 'TLS certificate verification turned off', 'keep verification on and configure RootCAs'],
  [GO, /exec\.Command\s*\(\s*"(?:sh|bash|cmd)"\s*,\s*"(?:-c|\/c)"/, 'a shell command (command injection)', 'call exec.Command with the program and separate arguments'],
  [GO, /\.(?:Query|Exec|QueryRow)\s*\(\s*(?:fmt\.Sprintf|"[^"]*"\s*\+)/, 'SQL built with string formatting (SQL injection)', 'use placeholders and pass arguments to Query/Exec'],
  [RB, /\bMarshal\.load\b|\bYAML\.load\b(?!_file)|(?<![\w.])eval\s*[( ]|\bsystem\s*\(\s*"[^"]*#\{/, 'unsafe deserialization, eval or an interpolated shell command', 'use JSON / YAML.safe_load, and system with separate arguments'],
  [PHP, /\bunserialize\s*\(|(?<![\w>])eval\s*\(|\b(?:shell_exec|passthru|system|exec)\s*\(\s*\$/, 'unserialize, eval or a shell call with a variable', 'use json_decode, and escapeshellarg or avoid the shell'],
  [JAVA, /new\s+ObjectInputStream\s*\(|Runtime\.getRuntime\(\)\.exec\s*\(/, 'Java deserialization or Runtime.exec', 'use a safe data format and ProcessBuilder with an argument list'],
  [CS, /new\s+BinaryFormatter\s*\(|TypeNameHandling\s*=\s*TypeNameHandling\.(?:All|Auto|Objects)/, 'unsafe .NET deserialization', 'use System.Text.Json without type-name handling'],
  [C, /\bgets\s*\(|\bstrcpy\s*\(|\bsprintf\s*\(|\bstrcat\s*\(/, 'an unbounded string function (buffer overflow)', 'use fgets, strncpy/strlcpy, snprintf or strncat'],
  [ANY_CODE, /\b(?:Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*['"][^\n]*credentials|origin\s*:\s*['"]\*['"][^\n]*credentials\s*:\s*true)/i, 'CORS allowing any origin together with credentials', 'list the allowed origins explicitly']
];

const SKIP_PATH = /(^|\/)(test|tests|__tests__|spec|specs|fixtures?|examples?|docs?|vendor|node_modules|third_party|dist|build)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$|\.(md|mdx|txt|rst|adoc|lock)$/i;

function addedLines(previous, next) {
  const before = new Map();
  for (const line of String(previous || '').split('\n')) before.set(line, (before.get(line) || 0) + 1);
  const added = [];
  for (const line of String(next || '').split('\n')) {
    const n = before.get(line) || 0;
    if (n) before.set(line, n - 1);
    else added.push(line);
  }
  return added;
}

export function securityFindings(previous, next, displayPath) {
  const file = String(displayPath || '').replace(/\\/g, '/');
  if (!file || SKIP_PATH.test(file)) return [];
  const lines = addedLines(previous, next).filter((l) => l.trim() && l.length < 2000);
  if (!lines.length) return [];
  const findings = [];
  for (const [ext, pattern, risk, fix] of RULES) {
    if (!ext.test(file)) continue;
    const hit = lines.find((l) => pattern.test(l) && !/^\s*(\/\/|#|\*|--|\/\*)/.test(l));
    if (hit) findings.push({ risk, fix, line: hit.trim().slice(0, 120) });
    if (findings.length >= 4) break;
  }
  if (findings.length < 4 && !/\.(example|sample|template)$/i.test(file)) {
    const secrets = findSecretsInText(lines.join('\n'));
    if (secrets && secrets.length) findings.push({ risk: 'a hard-coded credential', fix: 'read it from an environment variable or a secrets manager, and rotate it if it was real', line: '' });
  }
  return findings;
}

export function securityWarning(previous, next, displayPath, env = process.env) {
  if (String(env.OASIS_SECURITY_CHECK || '').trim() === '0') return '';
  const findings = securityFindings(previous, next, displayPath);
  if (!findings.length) return '';
  return 'Security check on ' + displayPath + ': the new code adds ' + findings.map((f) => f.risk + (f.line ? ' (`' + f.line + '`)' : '') + ' — ' + f.fix).join('; ') +
    '. Fix it now unless it is safe in this context (for example the input is fully trusted); if you keep it, say why in your summary.';
}
