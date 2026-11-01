// Corpora for the write-time guards: elision placeholders, weakened tests and
// committed credentials. Each list mixes positives (the guard must fire) with
// look-alike negatives (it must stay quiet), because a guard that fires on
// ordinary code trains people to turn it off.

// ---------------------------------------------------------------- elision
export const elision = [
  { id: 'js-rest-unchanged', text: 'function a() {}\n// ... rest of the code unchanged\n', placeholder: true },
  { id: 'js-existing-code', text: 'class A {\n  // ... existing code ...\n}\n', placeholder: true },
  { id: 'py-rest-of-file', text: 'import os\n# rest of the file remains the same\n', placeholder: true },
  { id: 'py-dots-unchanged', text: 'def f():\n    pass\n# ... unchanged\n', placeholder: true },
  { id: 'html-comment', text: '<body>\n<!-- ... rest of the page unchanged -->\n</body>\n', placeholder: true },
  { id: 'sql-comment', text: 'SELECT 1;\n-- ... remaining queries unchanged\n', placeholder: true },
  { id: 'block-comment', text: 'int main() {\n/* ... existing implementation ... */\n}\n', placeholder: true },
  { id: 'other-methods', text: 'class A {\n  // other methods stay the same\n}\n', placeholder: true },
  { id: 'keep-rest', text: 'export {};\n// [... keep the rest]\n', placeholder: true },
  { id: 'previous-code-here', text: 'const x = 1;\n// previous code here\n', placeholder: true },
  { id: 'same-as-before', text: 'fn main() {\n    // ... same as before\n}\n', placeholder: true },
  { id: 'rest-of-component', text: 'export default function App() {\n  // rest of component unchanged\n}\n', placeholder: true },

  { id: 'neg-real-comment', text: 'function a() {\n  // Return early when the cache is warm.\n  return 1;\n}\n', placeholder: false },
  { id: 'neg-rest-param', text: 'function f(...rest) {\n  return rest.length;\n}\n', placeholder: false },
  { id: 'neg-spread', text: 'const next = { ...state, ready: true };\n', placeholder: false },
  { id: 'neg-ellipsis-string', text: 'console.log("Loading...");\n', placeholder: false },
  { id: 'neg-todo', text: '// TODO: handle the remaining edge cases in the parser\nexport {};\n', placeholder: false },
  { id: 'neg-python-ellipsis', text: 'class Proto(Protocol):\n    def run(self) -> None: ...\n', placeholder: false },
  { id: 'neg-docs-unchanged', text: '# Behaviour is unchanged when the flag is off.\nFLAG = False\n', placeholder: false },
  { id: 'neg-markdown', text: 'The rest of the guide covers deployment.\n', placeholder: false }
];

// ------------------------------------------------------------ test tamper
const diff = (file, removed, added) => ['diff --git a/' + file + ' b/' + file, '--- a/' + file, '+++ b/' + file, '@@ -1,4 +1,4 @@', ...removed.map((l) => '-' + l), ...added.map((l) => '+' + l)].join('\n');

export const tamper = [
  { id: 'skip-test', diff: diff('test/parse.test.js', ["test('parses', () => {"], ["test.skip('parses', () => {"]), weakened: true },
  { id: 'xit', diff: diff('src/parse.spec.ts', ["  it('rejects bad input', () => {"], ["  xit('rejects bad input', () => {"]), weakened: true },
  { id: 'remove-assertion', diff: diff('test/math.test.js', ['  assert.equal(add(1, 2), 3);', '  assert.equal(add(-1, 1), 0);'], ['  assert.equal(add(1, 2), 3);']), weakened: true },
  { id: 'remove-test-case', diff: diff('test/math.test.js', ["test('negative', () => {", '  assert.equal(add(-1, -1), -2);', '});'], []), weakened: true },
  { id: 'pytest-skip', diff: diff('tests/test_api.py', ['def test_auth():'], ['@pytest.mark.skip(reason="flaky")', 'def test_auth():']), weakened: true },
  { id: 'go-skip', diff: diff('pkg/api_test.go', ['func TestAuth(t *testing.T) {'], ['func TestAuth(t *testing.T) {', '\tt.Skip("later")']), weakened: true },
  { id: 'only', diff: diff('test/a.test.js', ["test('a', () => {"], ["test.only('a', () => {"]), weakened: true },
  { id: 'expect-removed', diff: diff('src/__tests__/ui.test.tsx', ['  expect(screen.getByText("Save")).toBeVisible();'], []), weakened: true },

  { id: 'neg-add-test', diff: diff('test/math.test.js', [], ["test('zero', () => {", '  assert.equal(add(0, 0), 0);', '});']), weakened: false },
  { id: 'neg-rename-assert', diff: diff('test/math.test.js', ['  assert.equal(add(1, 2), 3);'], ['  assert.strictEqual(add(1, 2), 3);']), weakened: false },
  { id: 'neg-source-change', diff: diff('src/math.js', ['  return a - b;'], ['  return a + b;']), weakened: false },
  { id: 'neg-fix-expectation-typo', diff: diff('test/fmt.test.js', ["  assert.equal(fmt(1), '1.0');"], ["  assert.equal(fmt(1), '1.00');"]), weakened: false }
];

// ---------------------------------------------------------------- secrets
// Token-shaped values are assembled at run time so this file never contains a
// literal credential (and never trips repository secret scanning).
const rnd = (n, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789') => {
  let seed = n * 7919;
  let out = '';
  for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) % 2147483648; out += alphabet[seed % alphabet.length]; }
  return out;
};
const join = (...parts) => parts.join('');

export const secrets = [
  { id: 'github-pat', text: join('const token = "', 'gh', 'p_', rnd(36), '";'), secret: true },
  { id: 'github-fine', text: join('GH=', 'github', '_pat_', rnd(22), '_', rnd(59)), secret: true },
  { id: 'openai', text: join('OPENAI_API_KEY=', 's', 'k-proj-', rnd(48)), secret: true },
  { id: 'anthropic', text: join('key: "', 's', 'k-ant-api03-', rnd(90), '"'), secret: true },
  { id: 'aws-access', text: join('aws_access_key_id = ', 'AK', 'IA', rnd(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')), secret: true },
  { id: 'slack', text: join('SLACK=', 'xo', 'xb-', rnd(11, '0123456789'), '-', rnd(13, '0123456789'), '-', rnd(24)), secret: true },
  { id: 'stripe', text: join('stripe.key = "', 's', 'k_live_', rnd(28), '"'), secret: true },
  { id: 'private-key', text: join('-----BEGIN ', 'RSA PRIVATE KEY-----\n', rnd(64), '\n-----END RSA PRIVATE KEY-----'), secret: true },
  { id: 'password-assignment', text: join('DB_PASSWORD=', 'Tr0ub4dor', '&3horse'), secret: true },
  { id: 'url-credential', text: join('postgres://admin:', 'pa55w0rdQ', 'x9@db.internal:5432/app'), secret: true },

  { id: 'neg-env-reference', text: 'const key = process.env.OPENAI_API_KEY;', secret: false },
  { id: 'neg-placeholder', text: 'OPENAI_API_KEY=your-api-key-here', secret: false },
  { id: 'neg-example', text: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE', secret: false },
  { id: 'neg-template', text: 'password: ${DB_PASSWORD}', secret: false },
  { id: 'neg-hash', text: 'integrity: "sha512-' + rnd(20) + '"', secret: false },
  { id: 'neg-uuid', text: 'id = "3f2b8c4e-1a7d-4e9b-9c2a-7d5e6f8a9b0c"', secret: false },
  { id: 'neg-word-token', text: 'const tokenizer = new Tokenizer();', secret: false },
  { id: 'neg-url-no-cred', text: 'https://registry.npmjs.org/oasis-oss', secret: false }
];

// Held-out cases (see tool-calls.mjs): never used to tune the runtime.
export const heldoutElision = [
  { id: 'h-jsx-comment', text: 'return (\n  <div>\n    {/* ... rest of the JSX unchanged */}\n  </div>\n);\n', placeholder: true },
  { id: 'h-rust-existing', text: 'impl A {\n    // ... existing methods ...\n}\n', placeholder: true },
  { id: 'h-yaml-hash', text: 'jobs:\n  # ... remaining jobs unchanged\n', placeholder: true },
  { id: 'h-implementation-omitted', text: 'def run():\n    # implementation omitted for brevity\n', placeholder: true },
  { id: 'h-neg-ellipsis-doc', text: '/** Accepts a, b, ... and returns the sum. */\nexport const sum = (...n) => n.reduce((a, b) => a + b, 0);\n', placeholder: false },
  { id: 'h-neg-go-variadic', text: 'func f(args ...string) {}\n', placeholder: false }
];
export const heldoutTamper = [
  { id: 'h-describe-skip', diff: diff('test/api.test.js', ["describe('api', () => {"], ["describe.skip('api', () => {"]), weakened: true },
  { id: 'h-unittest-skip', diff: diff('tests/test_x.py', ['    def test_x(self):'], ['    @unittest.skip("wip")', '    def test_x(self):']), weakened: true },
  { id: 'h-rust-ignore', diff: diff('src/lib_test.rs', ['#[test]'], ['#[test]', '#[ignore]']), weakened: true },
  { id: 'h-neg-new-describe', diff: diff('test/b.test.js', [], ["describe('b', () => {", "  it('works', () => { expect(b()).toBe(1); });", '});']), weakened: false }
];
export const heldoutSecrets = [
  { id: 'h-gitlab', text: join('TOKEN=', 'gl', 'pat-', rnd(20)), secret: true },
  { id: 'h-google', text: join('key=', 'AI', 'za', rnd(35)), secret: true },
  { id: 'h-hf', text: join('HF_TOKEN=', 'h', 'f_', rnd(34)), secret: true },
  { id: 'h-npm', text: join('//registry.npmjs.org/:_authToken=', 'np', 'm_', rnd(36)), secret: true },
  { id: 'h-yaml-password', text: join('password: ', 'Zq8', 'vL2m', 'Wp4x'), secret: true },
  { id: 'h-neg-k8s-ref', text: 'password:\n  valueFrom:\n    secretKeyRef: { name: db, key: password }', secret: false },
  { id: 'h-neg-commit-sha', text: 'fixed in 87363cd2f4b1e0a9c7d6e5f4a3b2c1d0e9f8a7b6', secret: false },
  { id: 'h-neg-css-token', text: '--token-color-primary: #8a7cff;', secret: false }
];
