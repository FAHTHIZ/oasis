import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { executeTool } from '../src/tools.mjs';
import { shouldPromptForProviderBaseURL, validateBaseUrl } from '../src/config.mjs';

async function temporaryDirectory() {
  return await mkdtemp(path.join(os.tmpdir(), 'oasis-provider-setup-'));
}

function cleanProviderEnv(root) {
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config') };
  for (const key of ['OASIS_BASE_URL', 'OASIS_PROTOCOL', 'OASIS_MODEL', 'OASIS_LOCAL_API_KEY']) delete env[key];
  return env;
}

test('only Custom provider setup asks the user for a Base URL', () => {
  for (const provider of ['openai', 'anthropic', 'openrouter', 'gemini', 'ollama', 'omniroute', 'bedrock', 'vertex', 'foundry']) {
    assert.equal(shouldPromptForProviderBaseURL(provider), false, provider);
  }
  assert.equal(shouldPromptForProviderBaseURL('custom'), true);
});

test('Gemini model IDs are explained when accidentally entered as a provider URL', () => {
  assert.equal(validateBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai/'),
    'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.throws(
    () => validateBaseUrl('gemini-3.8-flash'),
    /model ID, not a provider URL.*Model name prompt/i
  );
});

test('OmniRoute local 401 is detected before model routing and requests the local key', async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    return new Response(JSON.stringify({ error: { message: 'Authentication required' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await executeTool('setup_omniroute', {}, {
    root,
    env: cleanProviderEnv(root),
    autoApprove: true
  });

  assert.equal(result.connected, false);
  assert.equal(result.needsLocalApiKey, true);
  assert.match(result.message, /local OmniRoute inference endpoint requires an API key/i);
  assert.deepEqual(calls, [{ url: 'http://127.0.0.1:20128/v1/models', method: 'GET' }]);
});

test('upstream model-provider 401 is not misreported as a local OmniRoute key failure', async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  const env = cleanProviderEnv(root);
  env.OASIS_LOCAL_API_KEY = 'test-local-gateway-key';
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push(target);
    if (target === 'http://127.0.0.1:20128/v1/models') {
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-local-gateway-key');
      return new Response(JSON.stringify({ data: [{ id: 'auto' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (target === 'http://127.0.0.1:20128/v1/chat/completions') {
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-local-gateway-key');
      return new Response(JSON.stringify({
        error: { message: 'provider: fixture-upstream rejected its own credentials (HTTP 401)' }
      }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('Unexpected request URL: ' + target);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await executeTool('setup_omniroute', {}, {
    root,
    env,
    autoApprove: true
  });

  assert.equal(result.connected, false);
  assert.notEqual(result.needsLocalApiKey, true);
  assert.match(result.message, /upstream model route/i);
  assert.match(result.message, /not a local endpoint-key failure/i);
  assert.match(result.message, /HTTP 401/);
  assert.deepEqual(calls, [
    'http://127.0.0.1:20128/v1/models',
    'http://127.0.0.1:20128/v1/chat/completions'
  ]);
  await assert.rejects(readFile(path.join(root, 'config', 'config.json'), 'utf8'), { code: 'ENOENT' });
});

test('an existing but unhealthy OmniRoute listener does not trigger a second server launch', async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  const calls = [];
  const env = cleanProviderEnv(root);
  env.PATH = '';
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ error: { message: 'gateway unavailable' } }), {
      status: 502,
      headers: { 'content-type': 'application/json' }
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await executeTool('setup_omniroute', {}, {
    root,
    env,
    autoApprove: true
  });

  assert.equal(result.connected, false);
  assert.match(result.message, /already responding.*HTTP 502/i);
  assert.match(result.message, /did not start a second server/i);
  assert.deepEqual(calls, ['http://127.0.0.1:20128/v1/models']);
});
