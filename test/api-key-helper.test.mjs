import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { clearApiKeyHelperCache, runApiKeyHelper } from '../src/api-key-helper.mjs';
import { loadSettings } from '../src/settings.mjs';
import { loadConfig } from '../src/config.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };

test('apiKeyHelper output authenticates requests and refreshes after a 401', async (t) => {
  clearApiKeyHelperCache();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-akh-'));
  const counter = path.join(dir, 'n');
  await writeFile(counter, '0');
  const script = path.join(dir, 'key.sh');
  await writeFile(script, '#!/bin/sh\nn=$(cat "' + counter + '"); n=$((n+1)); echo $n > "' + counter + '"; echo "key-$n"\n', { mode: 0o755 });
  const seen = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req) {}
    seen.push(req.headers.authorization);
    if (req.headers.authorization === 'Bearer key-1') { res.statusCode = 401; return res.end('{"error":{"message":"invalid api key"}}'); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'm', apiKey: '', apiKeyHelper: script, maxSteps: 2, maxCommandSeconds: 10 };
  const session = await createSession({ root: dir, config, settings, env: { ...process.env, HOME: dir } });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'hello');
  assert.deepEqual(seen, ['Bearer key-1', 'Bearer key-2']);
  await runAgentTurn(session, 'again');
  assert.equal(seen[2], 'Bearer key-2');
  assert.equal((await readFile(counter, 'utf8')).trim(), '2');
});

test('apiKeyHelper failures are reported clearly', async () => {
  await assert.rejects(runApiKeyHelper('exit 3'), /exited with code 3/);
  await assert.rejects(runApiKeyHelper('true'), /printed no API key/);
});

test('apiKeyHelper is read from settings and makes the config usable', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-akh-home-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-akh-root-'));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  await import('node:fs/promises').then((fs) => fs.mkdir(path.join(home, '.claude'), { recursive: true }));
  await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: 'echo k' }));
  const loaded = await loadSettings(root, { env });
  assert.equal(loaded.apiKeyHelper, 'echo k');
  const config = await loadConfig({ env: { ...env, OASIS_BASE_URL: 'https://api.example.com/v1', OASIS_MODEL: 'x', OASIS_API_KEY_HELPER: 'echo k' } });
  assert.equal(config.apiKeyHelper, 'echo k');
  assert.equal(config.configured, true);
});
