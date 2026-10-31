import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { scriptedEditKind, candidatePaths } from '../src/inplace-edit-check.mjs';
import { executeTool } from '../src/tools.mjs';
import { executePowerTool } from '../src/power-tools.mjs';

test('recognizes scripted in-place edits', () => {
  assert.equal(scriptedEditKind("sed -i 's/a/b/' src/x.js"), 'sed -i');
  assert.equal(scriptedEditKind("sed -i.bak -e 's/a/b/' x.js"), 'sed -i');
  assert.equal(scriptedEditKind("perl -pi -e 's/a/b/' x.js"), 'perl -i');
  assert.equal(scriptedEditKind("python3 -c \"p='x.py'; s=open(p).read().replace('a','b'); open(p,'w').write(s)\""), 'script');
  assert.equal(scriptedEditKind("sed -n '1,5p' x.js"), '');
  assert.equal(scriptedEditKind('npm test'), '');
  assert.deepEqual(candidatePaths("sed -i 's/a\\/b/c/' src/x.js README.md"), ['src/x.js', 'README.md']);
});

test('run_shell and run_command flag a scripted edit that changed nothing', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-noop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'app.js'), 'const mode = "dev";\n');
  const ctx = { root, autoApprove: true, approval: async () => true, env: process.env };
  const miss = await executePowerTool('run_shell', { command: "sed -i 's/production/prod/' app.js" }, ctx, root);
  assert.equal(miss.exitCode, 0);
  assert.match(miss.noOpEditWarning, /No-op edit: this sed -i command exited 0 but app\.js is byte-for-byte unchanged/);
  const hit = await executePowerTool('run_shell', { command: "sed -i 's/dev/prod/' app.js" }, ctx, root);
  assert.equal(hit.noOpEditWarning, undefined);
  assert.match(await readFile(path.join(root, 'app.js'), 'utf8'), /prod/);
  const script = await executePowerTool('run_shell', { command: "python3 -c \"p='app.js'; s=open(p).read().replace('missing','x'); open(p,'w').write(s)\"" }, ctx, root);
  assert.match(script.noOpEditWarning || '', /script command/);
  const viaCommand = await executeTool('run_command', { command: 'sed', args: ['-i', 's/nothing/here/', 'app.js'] }, ctx);
  assert.match(viaCommand.noOpEditWarning || '', /app\.js/);
});
