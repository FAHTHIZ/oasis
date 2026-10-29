import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
const { saveSession, loadSession } = await import(pathToFileURL(path.join(root, 'src/sessions.mjs')).href);
const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-eval-session-history-'));
try {
  const workspace = path.join(dir, 'workspace');
  await mkdir(workspace);
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(dir, 'config') };
  const messages = [
    { role: 'system', content: 'authoritative system context' },
    ...Array.from({ length: 150 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: 'message-' + index
    }))
  ];
  const saved = await saveSession({
    root: workspace,
    config: { protocol: 'openai-compatible', baseURL: 'https://provider.example/v1', model: 'fixture-model' },
    messages
  }, { env });
  const restored = await loadSession(workspace, saved.id, { env });
  assert.equal(restored.messages.length, 120);
  assert.equal(restored.messages[0].role, 'system');
  assert.equal(restored.messages[0].content, 'authoritative system context');
  assert.deepEqual(restored.messages.slice(1), messages.slice(-119));

  const exactLimitMessages = [
    { role: 'system', content: 'system context' },
    ...Array.from({ length: 119 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: 'message-' + index
    }))
  ];
  const exactLimit = await saveSession({
    root: workspace,
    config: { protocol: 'openai-compatible', baseURL: 'https://provider.example/v1', model: 'fixture-model' },
    messages: exactLimitMessages
  }, { env });
  const exactLimitRestored = await loadSession(workspace, exactLimit.id, { env });
  assert.equal(exactLimitRestored.messages.length, 120);
  assert.deepEqual(exactLimitRestored.messages, exactLimitMessages);

  const shortMessages = [
    { role: 'system', content: 'system context' },
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'answer' }
  ];
  const short = await saveSession({
    root: workspace,
    config: { protocol: 'openai-compatible', baseURL: 'https://provider.example/v1', model: 'fixture-model' },
    messages: shortMessages
  }, { env });
  const shortRestored = await loadSession(workspace, short.id, { env });
  assert.deepEqual(shortRestored.messages, shortMessages);

  const regressionTests = await readFile(path.join(root, 'test/session-history.test.mjs'), 'utf8');
  assert.match(regressionTests, /preserves system context and newest messages beyond the limit/);
  assert.match(regressionTests, /leaves short histories unchanged/);
  assert.match(regressionTests, /preserves histories at exactly the limit/);
} finally {
  await rm(dir, { recursive: true, force: true });
}
