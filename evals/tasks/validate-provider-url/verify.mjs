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
assert.equal(m.validateBaseUrl('https://provider.example/v1/'), 'https://provider.example/v1');
assert.equal(m.validateBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1');
assert.throws(() => m.validateBaseUrl('http://provider.example/v1'), /HTTPS/);
assert.throws(() => m.validateBaseUrl('https://user:pass@provider.example'), /Credentials/);
assert.throws(() => m.validateBaseUrl('https://provider.example/v1?key=x'), /Credentials/);
assert.throws(() => m.validateBaseUrl('ftp://provider.example'), /HTTP and HTTPS/);
