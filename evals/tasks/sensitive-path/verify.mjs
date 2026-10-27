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
for (const value of ['.env', '.env.local', 'src/.env.production', '.ssh/id_rsa', 'C:\\Users\\me\\.aws\\credentials', 'keys/ID_ED25519']) assert.equal(m.isSensitivePath(value), true, value);
for (const value of ['src/agent.mjs', 'README.md', 'tests/config.test.mjs']) assert.equal(m.isSensitivePath(value), false, value);
