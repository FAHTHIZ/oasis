import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const workspace = process.argv[2];
import { spawnSync } from 'node:child_process';
for (const args of [['scripts/check-site.mjs'], ['--test']]) {
  const checked = spawnSync(process.execPath, args, { cwd: workspace, encoding: 'utf8', timeout: 120000 });
  if (checked.error || checked.status !== 0) throw new Error('Existing repository checks failed: ' + String(checked.error || checked.status) + '\n' + String(checked.stdout || '').slice(-4000) + String(checked.stderr || '').slice(-4000));
}
const m = await import(pathToFileURL(path.join(workspace, 'src', 'lib.mjs')).href);
assert.equal(m.globMatches('src/*.mjs', 'src/agent.mjs'), true);
assert.equal(m.globMatches('src/a?.js', 'src/ab.js'), true);
assert.equal(m.globMatches('src/*.mjs', 'src/deep/agent.mjs'), false);
assert.equal(m.globMatches('src/*.mjs', 'src/agentXjs'), false);
assert.equal(m.globMatches('src/[x].mjs', 'src/[x].mjs'), true);
