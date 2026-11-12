import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { runHeadless } from '../src/headless.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
const call = (id, name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

async function run(t, extra) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-reqver-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }));
  await writeFile(path.join(root, 'a.mjs'), 'export const add = (a, b) => a - b;\n');
  const { config } = await scriptedModel(t, [
    call('c1', 'edit_file', { path: 'a.mjs', old_string: 'a - b', new_string: 'a + b' }),
    { content: 'Fixed add() in a.mjs. I did not run the tests.' }
  ]);
  return runHeadless({ prompt: 'fix add', root, config: { ...config, maxSteps: 6 }, autoApprove: true, outputFormat: 'json', sessionOptions: { settings }, env: { ...process.env, OASIS_PROGRESS: '0', OASIS_ASSISTED_VERIFICATION: '0' }, write: () => {}, ...extra });
}

test('-p exits 0 on unverified changes by default', async (t) => {
  const { exitCode, summary } = await run(t, {});
  assert.equal(summary.verification_issues && summary.verification_issues.length > 0, true);
  assert.equal(exitCode, 0);
});

test('--require-verified turns unverified changes into exit 1', async (t) => {
  const { exitCode, summary } = await run(t, { requireVerified: true });
  assert.equal(exitCode, 1);
  assert.equal(summary.subtype, 'error_not_verified');
  assert.equal(summary.is_error, true);
});
