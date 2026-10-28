import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runHeadless, parseStreamInputLine } from '../src/headless.mjs';
import { createSession, closeSession } from '../src/agent.mjs';
import { loadSettings } from '../src/settings.mjs';
import { estimateCostUsd, priceFor, formatUsd } from '../src/pricing.mjs';
import { parseMcpServerEntries } from '../src/mcp-project.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
const tmp = () => mkdtemp(path.join(os.tmpdir(), 'oasis-flags-'));

test('pricing estimates known models, treats local endpoints as free, and honors overrides', () => {
  assert.equal(priceFor('claude-sonnet-4-5').input, 3);
  assert.equal(priceFor('gpt-5-mini').output, 2);
  assert.equal(priceFor('qwen2.5', { config: { protocol: 'ollama' } }).local, true);
  assert.equal(priceFor('mystery-model'), null);
  assert.equal(priceFor('mine-v2', { overrides: { 'mine': { input: 9, output: 9 } } }).input, 9);
  const cost = estimateCostUsd('claude-sonnet-4-5', { inputTokens: 1_000_000, outputTokens: 100_000 });
  assert.ok(Math.abs(cost - 4.5) < 1e-9);
  assert.equal(formatUsd(0.004), '$0.0040');
  assert.equal(formatUsd(3.14159), '$3.14');
});

test('--max-budget-usd stops the run with error_max_budget_usd', async (t) => {
  const root = await tmp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config } = await scriptedModel(t, [{ content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } }] }, { content: 'done' }]);
  let out = '';
  const { summary } = await runHeadless({ prompt: 'go', root, config, outputFormat: 'json', env: { ...process.env, OASIS_PRICE_INPUT: '1000000' }, sessionOptions: { settings, maxBudgetUsd: 1 }, write: (text) => { out += text; } });
  assert.equal(summary.subtype, 'error_max_budget_usd');
  assert.ok(summary.total_cost_usd >= 1);
  assert.match(summary.result, /max-budget-usd/);
});

test('--fallback-model switches models when the main one is overloaded', async (t) => {
  const root = await tmp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    seen.push(payload.model);
    if (payload.model === 'main') { res.statusCode = 529; res.end('{"error":{"message":"overloaded"}}'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'from backup' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'main', apiKey: '', maxSteps: 4 };
  const { summary } = await runHeadless({ prompt: 'hi', root, config, outputFormat: 'json', sessionOptions: { settings, fallbackModel: 'backup' }, write: () => {} });
  assert.equal(summary.result, 'from backup');
  assert.equal(summary.fallback_model, 'backup');
  assert.deepEqual([...new Set(seen)], ['main', 'backup']);
});

test('--tools limits the offered tools, --system-prompt replaces the prompt, --agents adds agents', async (t) => {
  const root = await tmp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'm' }, settings, tools: ['Read', 'Grep'], systemPromptOverride: 'You are a test.', agentsInline: { checker: { description: 'Checks things', prompt: 'Check.', tools: ['Read'] } } });
  t.after(() => closeSession(session));
  const names = session.toolDefinitions.map((tool) => tool.function.name);
  assert.ok(names.includes('read_file'));
  assert.ok(names.includes('grep'));
  assert.ok(!names.includes('run_command'));
  assert.ok(!names.includes('write_file'));
  assert.ok(session.messages[0].content.startsWith('You are a test.'));
  assert.ok(!session.messages[0].content.includes('Oasis OSS'));
  assert.equal(session.agents.checker.description, 'Checks things');
  assert.deepEqual(session.agents.checker.tools, ['read_file']);
});

test('--settings overrides and --setting-sources filtering', async (t) => {
  const root = await tmp();
  const home = await tmp();
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }));
  const env = { OASIS_HOME: home };
  const all = await loadSettings(root, { env, extraSettings: [{ settings: { permissions: { allow: ['Read'] }, fallbackModel: 'fb' } }] });
  assert.ok(all.permissions.deny.includes('Bash(rm:*)'));
  assert.ok(all.permissions.allow.includes('Read'));
  assert.equal(all.fallbackModel, 'fb');
  const projectOnly = await loadSettings(root, { env, settingSources: ['project'] });
  assert.ok(!projectOnly.permissions.deny.includes('Bash(rm:*)'));
});

test('--mcp-config entries parse like .mcp.json and stream-json input lines parse', () => {
  const { servers, failures } = parseMcpServerEntries({ mcpServers: { Docs: { command: 'node', args: ['server.js'] }, web: { type: 'http', url: 'https://example.com/mcp' } } }, {}, 'flag');
  assert.equal(failures.length, 0);
  assert.deepEqual(servers.map((s) => [s.name, s.source]), [['docs', 'flag'], ['web', 'flag']]);
  assert.equal(parseStreamInputLine('{"type":"user","message":{"role":"user","content":"hello"}}'), 'hello');
  assert.equal(parseStreamInputLine('{"type":"user","message":{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}}'), 'a\nb');
  assert.equal(parseStreamInputLine('{"type":"control"}'), null);
  assert.throws(() => parseStreamInputLine('nope'), /JSON object/);
});

test('oasis -p --input-format stream-json runs one turn per message in one session', async (t) => {
  const root = await tmp();
  const home = await tmp();
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const { config, requests } = await scriptedModel(t, [(payload) => ({ content: 'echo ' + payload.messages.filter((m) => m.role === 'user').length })]);
  const child = spawn(process.execPath, [CLI, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--replay-user-messages'], {
    cwd: root,
    env: { ...process.env, OASIS_HOME: home, OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_NO_ANIMATION: '1' }
  });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'one' } }) + '\n');
  child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: 'two' } }) + '\n');
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, out);
  const events = out.trim().split('\n').map((line) => JSON.parse(line));
  const turns = events.filter((event) => event.type === 'result' && event.subtype === 'turn');
  assert.deepEqual(turns.map((event) => event.result), ['echo 1', 'echo 2']);
  assert.equal(events.filter((event) => event.type === 'user').length, 2);
  assert.equal(requests.length, 2);
});
