import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { runHeadless } from '../src/headless.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };

async function run(t, replies) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config } = await scriptedModel(t, replies);
  return runHeadless({ prompt: 'say hi', root, config: { ...config, maxSteps: 6 }, autoApprove: true, outputFormat: 'json', sessionOptions: { settings }, env: { ...process.env, OASIS_PROGRESS: '0' }, write: () => {} });
}

// Regression: a model that only ever returned empty replies produced
// subtype "success", is_error false and exit 0, so CI took it for a pass.
test('-p exits 1 when the model never replies', async (t) => {
  const { exitCode, summary } = await run(t, [{ content: '' }, { content: '' }, { content: '' }]);
  assert.match(summary.result, /without a reply/);
  assert.equal(summary.is_error, true);
  assert.equal(summary.subtype, 'error_during_execution');
  assert.equal(summary.empty_reply, true);
  assert.equal(exitCode, 1);
});

test('-p still succeeds when a re-ask gets an answer', async (t) => {
  const { exitCode, summary } = await run(t, [{ content: '' }, { content: 'hi' }]);
  assert.equal(summary.result, 'hi');
  assert.equal(summary.is_error, false);
  assert.equal(summary.subtype, 'success');
  assert.equal(summary.empty_reply, undefined);
  assert.equal(exitCode, 0);
});
