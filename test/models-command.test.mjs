import test from 'node:test';
import assert from 'node:assert/strict';
import { modelsCommand, formatModelTable } from '../src/models-command.mjs';
import { clearProviderModelCache } from '../src/provider-models.mjs';

function sink() { let text = ''; return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } }; }
const fetchImpl = async () => new Response(JSON.stringify({ data: [{ id: 'alpha-large' }, { id: 'alpha-mini' }, { id: 'beta' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'alpha-mini', apiKey: 'k' };
const env = { HOME: '/nonexistent-oasis-home', OASIS_MODEL_CATALOG: 'off' };

test('oasis models prints a table, marks the current model and filters', async () => {
  clearProviderModelCache();
  const out = sink(); const err = sink();
  assert.equal(await modelsCommand([], { env, stdout: out, stderr: err, fetchImpl, configOverride: config, root: '/tmp' }), 0);
  assert.match(out.text, /^\s+MODEL/m);
  assert.match(out.text, /^\*\s+alpha-mini/m);
  assert.match(out.text, /3 of 3 models from 127\.0\.0\.1:9 · current: alpha-mini/);
  const filtered = sink();
  assert.equal(await modelsCommand(['alpha'], { env, stdout: filtered, stderr: err, fetchImpl, configOverride: config, root: '/tmp' }), 0);
  assert.doesNotMatch(filtered.text, /\bbeta\b/);
  const none = sink();
  assert.equal(await modelsCommand(['zzz'], { env, stdout: none, stderr: err, fetchImpl, configOverride: config, root: '/tmp' }), 1);
  assert.match(none.text, /No models match "zzz"/);
});

test('oasis models --json is machine-readable; failures exit 1 with the reason', async () => {
  clearProviderModelCache();
  const out = sink();
  assert.equal(await modelsCommand(['--json'], { env, stdout: out, stderr: sink(), fetchImpl, configOverride: config, root: '/tmp' }), 0);
  const body = JSON.parse(out.text);
  assert.equal(body.current, 'alpha-mini');
  assert.deepEqual(body.models.map((m) => m.id), ['alpha-large', 'alpha-mini', 'beta']);
  clearProviderModelCache();
  const err = sink();
  const failing = async () => new Response('nope', { status: 401 });
  assert.equal(await modelsCommand([], { env, stdout: sink(), stderr: err, fetchImpl: failing, configOverride: config, root: '/tmp' }), 1);
  assert.match(err.text, /HTTP 401/);
  assert.equal(await modelsCommand(['--bogus'], { env, stdout: sink(), stderr: sink(), configOverride: config }), 2);
});

test('formatModelTable aligns columns and leaves unknown facts blank', () => {
  const table = formatModelTable([{ id: 'a', contextWindow: 200000, inputPerMTok: 3, outputPerMTok: 15, tools: true, images: true }, { id: 'long-model-name' }], 'a');
  const lines = table.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^\*\s+a\s+200K\s+\$3\s+\$15\s+yes\s+yes$/);
  assert.match(lines[2], /^\s+long-model-name$/);
});

test('oasis models with no provider configured says so without a network call', async () => {
  clearProviderModelCache();
  let called = 0;
  const spy = async () => { called += 1; return new Response('{}', { status: 401 }); };
  const out = sink(); const err = sink();
  const unconfigured = { protocol: 'openai-responses', baseURL: 'https://api.openai.com/v1', model: 'gpt-x', configured: false };
  assert.equal(await modelsCommand([], { env, stdout: out, stderr: err, fetchImpl: spy, configOverride: unconfigured, root: '/tmp' }), 1);
  assert.equal(called, 0);
  assert.match(err.text, /No model provider is configured\. Run oasis setup/);
  const json = sink();
  assert.equal(await modelsCommand(['--json'], { env, stdout: json, stderr: sink(), fetchImpl: spy, configOverride: unconfigured, root: '/tmp' }), 1);
  assert.equal(JSON.parse(json.text).models, null);
});

test('oasis models explains a 401 as an API-key problem', async () => {
  clearProviderModelCache();
  const err = sink();
  const denied = async () => new Response('{"error":"bad key"}', { status: 401 });
  assert.equal(await modelsCommand([], { env, stdout: sink(), stderr: err, fetchImpl: denied, configOverride: config, root: '/tmp' }), 1);
  assert.match(err.text, /HTTP 401 .*Check the API key/);
});
