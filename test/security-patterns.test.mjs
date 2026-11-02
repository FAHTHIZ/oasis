import test from 'node:test';
import assert from 'node:assert/strict';
import { securityFindings, securityWarning } from '../src/security-patterns.mjs';

const risks = (prev, next, file) => securityFindings(prev, next, file).map((f) => f.risk);

test('flags risky calls in newly added code', () => {
  assert.match(risks('', 'const v = eval(input);', 'src/a.js').join(), /dynamic code/);
  assert.match(risks('', 'el.innerHTML = userText;', 'src/ui.ts').join(), /XSS/);
  assert.match(risks('', 'exec(`git log ${branch}`)', 'src/run.mjs').join(), /command injection/);
  assert.match(risks('', 'data = pickle.loads(blob)', 'app/x.py').join(), /unpickling/);
  assert.match(risks('', 'cfg = yaml.load(f)', 'app/x.py').join(), /SafeLoader/);
  assert.match(risks('', 'subprocess.run(cmd, shell=True)', 'app/x.py').join(), /shell command/);
  assert.match(risks('', 'requests.get(u, verify=False)', 'app/x.py').join(), /TLS/);
  assert.match(risks('', 'cur.execute(f"SELECT * FROM t WHERE id={i}")', 'app/db.py').join(), /SQL/);
  assert.match(risks('', 'tls.Config{InsecureSkipVerify: true}', 'cmd/main.go').join(), /TLS/);
  assert.match(risks('', 'strcpy(buf, src);', 'src/x.c').join(), /buffer overflow/);
});

test('safe variants and unchanged code are not flagged', () => {
  assert.deepEqual(risks('', 'cfg = yaml.load(f, Loader=yaml.SafeLoader)', 'app/x.py'), []);
  assert.deepEqual(risks('', 'const x = JSON.parse(input); execFile("git", ["log"]);', 'src/a.js'), []);
  assert.deepEqual(risks('', 'el.textContent = userText;', 'src/ui.ts'), []);
  assert.deepEqual(risks('', 'cur.execute("SELECT * FROM t WHERE id=%s", (i,))', 'app/db.py'), []);
  const old = 'const v = eval(input);\n';
  assert.deepEqual(risks(old, old + 'const y = 2;\n', 'src/a.js'), []);
  assert.deepEqual(risks('', '// never use eval(x) here', 'src/a.js'), []);
});

test('tests, fixtures and docs are skipped', () => {
  assert.deepEqual(risks('', 'eval(x)', 'test/a.test.mjs'), []);
  assert.deepEqual(risks('', 'eval(x)', 'docs/guide.md'), []);
  assert.deepEqual(risks('', 'pickle.loads(b)', 'app/test_x.py'), []);
});

test('warning text and opt-out', () => {
  const w = securityWarning('', 'el.innerHTML = t;', 'src/ui.js', {});
  assert.match(w, /Security check on src\/ui\.js/);
  assert.match(w, /textContent/);
  assert.equal(securityWarning('', 'el.innerHTML = t;', 'src/ui.js', { OASIS_SECURITY_CHECK: '0' }), '');
  assert.equal(securityWarning('', 'const a = 1;', 'src/ui.js', {}), '');
});
