import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { resolveCompletionTarget, readOasisConfig, requestCompletion, cleanCompletion, shouldSuggest } = require('../ide/vscode/src/completion.js');

test('completions use the OASIS config when VS Code settings are empty', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oasis-complete-'));
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ protocol: 'openai-compatible', baseURL: 'http://localhost:11434/v1', model: 'qwen2.5-coder:3b', apiKey: 'ollama' }));
  const config = readOasisConfig({ OASIS_CONFIG_DIR: dir });
  assert.deepEqual(resolveCompletionTarget({}, config, {}), { protocol: 'ollama', baseURL: 'http://localhost:11434/v1', model: 'qwen2.5-coder:3b', apiKey: 'ollama' });
  const custom = resolveCompletionTarget({ baseUrl: 'https://api.example.com/v1', model: 'fast' }, config, { OPENAI_API_KEY: 'env-key' });
  assert.deepEqual(custom, { protocol: 'openai-compatible', baseURL: 'https://api.example.com/v1', model: 'fast', apiKey: 'env-key' }, 'a custom endpoint never receives the OASIS key');
  assert.equal(resolveCompletionTarget({}, { ...config, completionModel: 'qwen2.5-coder:1.5b' }, {}).model, 'qwen2.5-coder:1.5b');
  assert.equal(resolveCompletionTarget({}, { protocol: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-haiku' }, {}).protocol, 'anthropic');
});

test('Ollama completions use fill-in-the-middle with the suffix', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ response: 'a + b;\n' }), { status: 200 }); };
  const text = await requestCompletion({ protocol: 'ollama', baseURL: 'http://localhost:11434/v1', model: 'm', apiKey: '' }, { prefix: 'function add(a, b) {\n  return ', suffix: '\n}\n' }, { fetchImpl });
  assert.equal(seen.url, 'http://localhost:11434/api/generate');
  assert.equal(seen.body.prompt, 'function add(a, b) {\n  return ');
  assert.equal(seen.body.suffix, '\n}\n');
  assert.equal(seen.body.stream, false);
  assert.equal(text, 'a + b;');
});

test('chat endpoints get an instruction prompt and the answer is tidied', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ choices: [{ message: { content: '```js\nreturn a + b;\n```' } }] }), { status: 200 }); };
  const text = await requestCompletion({ protocol: 'openai-compatible', baseURL: 'https://api.example.com/v1', model: 'm', apiKey: 'k' }, { prefix: 'function add(a, b) {\n  ', suffix: '\n}', relativePath: 'src/add.js', languageId: 'javascript' }, { fetchImpl });
  assert.equal(seen.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(seen.init.headers.authorization, 'Bearer k');
  assert.match(seen.body.messages[1].content, /src\/add\.js \(javascript\)/);
  assert.match(seen.body.messages[1].content, /<CURSOR>/);
  assert.equal(text, 'return a + b;');
});

test('cleanCompletion drops repeated context and stops at the line when mid-line', () => {
  assert.equal(cleanCompletion('const total = sum(items);', { prefix: 'x\nconst total = ', suffix: '\n' }), 'sum(items);');
  assert.equal(cleanCompletion('items.length) {\n  more()', { prefix: 'if (', suffix: ' // check\n' }), 'items.length) {');
  assert.equal(cleanCompletion('  a();\n  b();\n\n  c();', { prefix: '{\n', suffix: '\n}' }), '  a();\n  b();');
  assert.equal(cleanCompletion('one();\nreturn value;\n}', { prefix: '{\n', suffix: 'return value;\n}' }), 'one();\n');
  assert.equal(cleanCompletion('   \n', { prefix: 'x', suffix: '' }), '');
});

test('no suggestion in an empty file or in the middle of a word', () => {
  assert.equal(shouldSuggest({ prefix: '', suffix: '' }), false);
  assert.equal(shouldSuggest({ prefix: 'const na', suffix: 'me = 1' }), false);
  assert.equal(shouldSuggest({ prefix: 'const name = ', suffix: '\n' }), true);
});

test('a missing model and HTTP errors are explained', async () => {
  await assert.rejects(requestCompletion({ protocol: 'ollama', baseURL: 'http://x', model: '' }, { prefix: 'a' }), /oasis setup/);
  const fetchImpl = async () => new Response('model not found', { status: 404 });
  await assert.rejects(requestCompletion({ protocol: 'ollama', baseURL: 'http://x', model: 'm' }, { prefix: 'a' }, { fetchImpl }), /HTTP 404: model not found/);
});
