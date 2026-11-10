import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { nodeChildEnv } from '../src/node-process.mjs';

test('children that run OASIS scripts run Electron as node inside the desktop app only', () => {
  const env = { PATH: '/bin' };
  assert.equal(nodeChildEnv(env, { versions: { node: '22.0.0' } }), env, 'plain Node.js: unchanged');
  const inElectron = nodeChildEnv(env, { versions: { node: '24.0.0', electron: '45.2.3' } });
  assert.deepEqual(inElectron, { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined, 'the caller env is not modified');
});

test('every spawn of process.execPath that runs OASIS code goes through nodeChildEnv', async () => {
  for (const file of ['background-sessions.mjs', 'diagnostics.mjs', 'claude-plugins.mjs']) {
    const source = await readFile(new URL('../src/' + file, import.meta.url), 'utf8');
    assert.match(source, /nodeChildEnv\(/, file);
  }
  const background = await readFile(new URL('../src/background-sessions.mjs', import.meta.url), 'utf8');
  assert.equal((background.match(/spawn\(options\.execPath \|\| process\.execPath[^\n]*env: nodeChildEnv\(/g) || []).length, 2);
});
