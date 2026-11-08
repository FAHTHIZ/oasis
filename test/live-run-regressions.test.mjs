// Regressions found in live runs against real providers and servers (2026-11-08):
// OmniRoute as a gateway, slow free models, one-at-a-time 429s and MCP annotations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_PROVIDERS, providerForEndpoint, providerApiKey } from '../src/provider-registry.mjs';
import { LOCAL_SERVERS } from '../src/hardware.mjs';
import { priceFor } from '../src/pricing.mjs';
import { isUnconfiguredRouteError } from '../src/provider-retry.mjs';

test('omniroute is a built-in gateway, not a local model server', () => {
  const entry = BUILTIN_PROVIDERS.omniroute;
  assert.equal(entry.baseURL, 'http://127.0.0.1:20128/v1');
  assert.equal(entry.protocol, 'openai-compatible');
  assert.equal(entry.gateway, true);
  assert.ok(!LOCAL_SERVERS.some((server) => server.id === 'omniroute'), 'setup never recommends a gateway as a local model');
  assert.equal(providerForEndpoint('http://127.0.0.1:20128/v1', 'openai-compatible'), 'omniroute');
  assert.equal(providerApiKey('omniroute', { OMNIROUTE_API_KEY: 'sk-test' }), 'sk-test');
});

test('models behind OmniRoute are never priced as free local models', () => {
  const routed = priceFor('llm7/codestral-latest', { config: { baseURL: 'http://127.0.0.1:20128/v1' }, env: {} });
  assert.ok(!routed || !routed.local);
  const local = priceFor('qwen3:4b', { config: { baseURL: 'http://localhost:11434/v1' }, env: {} });
  assert.equal(local.local, true);
});

test('a gateway route with no account is not retried', () => {
  assert.equal(isUnconfiguredRouteError(503, '[503]: Devin agentic bridge is not configured: set DEVIN_AGENTIC_HOME'), true);
  assert.equal(isUnconfiguredRouteError(503, 'No active connections for provider auggie'), true);
  assert.equal(isUnconfiguredRouteError(503, 'The model is overloaded. Please try again later.'), false);
  assert.equal(isUnconfiguredRouteError(400, 'not configured'), false);
});

test('the error advice for an unconfigured gateway route says what to do', async () => {
  const { apiErrorAdvice } = await import('../src/api-error.mjs');
  assert.match(apiErrorAdvice(503, '[503]: Devin agentic bridge is not configured'), /no working account/);
  assert.match(apiErrorAdvice(503, 'overloaded'), /server-side problem/);
});

test('a one-request-at-a-time 429 waits briefly instead of failing', async () => {
  const { shortRateLimitMs } = await import('../src/provider-retry.mjs');
  assert.equal(shortRateLimitMs('{"error":{"code":"RATE_LIMITED","message":"Your previous request is still running. The Classic API answers 1 request at a time per IP."}}'), 5000);
  assert.equal(shortRateLimitMs('Too many concurrent requests'), 5000);
  assert.equal(shortRateLimitMs('Daily token quota exceeded'), null);
  assert.equal(shortRateLimitMs('concurrency limit reached; add billing credit'), null);
});

test('only read-only, closed-world tools from user MCP servers skip the auto-mode classifier', async () => {
  const { mcpToolDefinitions } = await import('../src/mcp.mjs');
  const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const tools = [
    { name: 'get-sum', inputSchema: { type: 'object' }, annotations: ro },
    { name: 'get-env', inputSchema: { type: 'object' }, annotations: ro },
    { name: 'fetch-page', inputSchema: { type: 'object' }, annotations: { ...ro, openWorldHint: true } },
    { name: 'toggle', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
    { name: 'plain', inputSchema: { type: 'object' } }
  ];
  const { map } = mcpToolDefinitions(new Map([['mine', { source: 'user', tools }], ['repo', { source: 'project', tools }]]));
  const readOnly = [...map].filter(([, entry]) => entry.readOnly).map(([id]) => id);
  assert.deepEqual(readOnly, ['mcp_mine_get-sum']);
});

test('a commit without a Git identity says so instead of blaming hooks', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { runGitTool } = await import('../src/git-tools.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-noid-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-noid-home-'));
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'none'), EMAIL: '' };
  try {
    execFileSync('git', ['init', '-q'], { cwd: root, env });
    execFileSync('git', ['config', 'user.useConfigOnly', 'true'], { cwd: root, env });
    await writeFile(path.join(root, 'a.txt'), 'a\n');
    const result = await runGitTool('git_commit', root, { message: 'Add a' }, { autoApprove: true, env });
    assert.equal(result.ok, false);
    assert.match(result.message, /no author name and email/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('a compound shell line is allowed only when allow rules cover every piece', async () => {
  const { PermissionPolicy } = await import('../src/permissions.mjs');
  const policy = new PermissionPolicy({ permissions: { allow: ['Bash(git add:*)'], ask: [], deny: ['Bash(git commit --amend:*)'], defaultMode: 'default' } });
  policy.rememberForSession('Bash(git commit:*)');
  const verdict = (command) => policy.evaluate('run_shell', { command }).decision;
  assert.equal(verdict('git add math.js && git commit -m "Fix bug"'), 'allow');
  assert.equal(verdict('git add . && git push'), 'default');
  assert.equal(verdict('git add x && git commit -m "$(rm -rf ~)"'), 'default');
  assert.equal(verdict('git add a; git commit -m ok | tee /tmp/x'), 'default');
  assert.equal(verdict('git add a && git commit --amend -m x'), 'deny');
});

test('an upstream glitch inside a chat stream restarts the reply; permanent errors stay final', async () => {
  const { chatStreamError } = await import('../src/provider-stream.mjs');
  const glitch = chatStreamError({ message: 'Chat Completions provider returned invalid or omitted terminal usage' });
  assert.equal(glitch.code, 'OASIS_STREAM_INTERRUPTED');
  assert.match(glitch.message, /interrupted: Chat Completions provider/);
  assert.equal(chatStreamError({ message: 'Rate limited', code: 429 }).code, 'OASIS_STREAM_INTERRUPTED');
  for (const permanent of [{ message: 'This model\'s maximum context length is 8192 tokens' }, { message: 'Invalid API key' }, { message: 'nope', code: 400 }, { message: 'You exceeded your current quota' }]) {
    assert.equal(chatStreamError(permanent).code, undefined, permanent.message);
  }
});

test('a repeated commit after success says the work is already committed', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { runGitTool } = await import('../src/git-tools.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-recommit-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
    await writeFile(path.join(root, 'a.txt'), 'a\n');
    const session = {};
    const first = await runGitTool('git_commit', root, { message: 'Add a' }, { autoApprove: true, session });
    assert.equal(first.ok, true);
    const again = await runGitTool('git_commit', root, { message: 'Add a again' }, { autoApprove: true, session });
    assert.equal(again.ok, false);
    assert.match(again.message, new RegExp('already created ' + first.commit + '.*Do not commit again'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a text-only model that rejects an attached image gets the conversation without it, now and on later turns', async (t) => {
  const http = await import('node:http');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createSession, runAgentTurn, closeSession } = await import('../src/agent.mjs');
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push(body);
    const sentImage = JSON.stringify(body.messages).includes('image_url');
    res.writeHead(sentImage ? 400 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(sentImage
      ? { error: { message: 'This model does not support image input' } }
      : { choices: [{ message: { role: 'assistant', content: 'I cannot see images with this model.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-textonly-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-textonly-home-'));
  t.after(async () => { server.close(); await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'x', model: 'text-only-1', configured: true };
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const retries = [];
  const first = await runAgentTurn(session, 'What error is in this screenshot?', { env, images: [{ mediaType: 'image/png', data: png.toString('base64') }], onProviderRetry: (event) => retries.push(event.reason) });
  assert.match(String(first.content || first.text || first), /cannot see images/);
  assert.match(retries.join(' '), /cannot read images/);
  const notes = JSON.stringify(bodies[bodies.length - 1].messages);
  assert.match(notes, /1 image not sent: text-only-1 cannot read images/);
  const before = bodies.length;
  await runAgentTurn(session, 'OK, then just say hi.', { env });
  assert.equal(bodies.length, before + 1, 'the next turn is not rejected again');
  assert.ok(session.messages.some((message) => Array.isArray(message.images) && message.images.length), 'the stored image is kept for a later vision model');
});

test('optional tool fields sent as null are dropped instead of failing validation', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { scriptedModel, toolCall } = await import('./helpers/scripted-model.mjs');
  const { createSession, runAgentTurn, closeSession } = await import('../src/agent.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-nulls-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.txt'), 'alpha\n');
  const { config, requests } = await scriptedModel(t, [toolCall('c1', 'read_file', { path: 'a.txt', offset: null, limit: null }), { content: 'done' }]);
  const session = await createSession({ root, config, env: { ...process.env, HOME: root, OASIS_CONFIG_DIR: path.join(root, '.cfg') } });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'read a.txt', { autoApprove: true });
  const toolMessage = requests[1].messages.find((message) => message.role === 'tool');
  assert.match(String(toolMessage.content), /alpha/);
  assert.doesNotMatch(String(toolMessage.content), /Invalid arguments/);
});

test('subagent requests stream so a silent provider trips the idle watchdog instead of the long header timeout', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { scriptedModel, toolCall } = await import('./helpers/scripted-model.mjs');
  const { createSession, runAgentTurn, closeSession } = await import('../src/agent.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-substream-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config, requests } = await scriptedModel(t, [
    (payload) => payload.messages[0].content.includes('SUBAGENT MODE') ? { content: 'child done' } : payload.messages.some((m) => m.role === 'tool') ? { content: 'parent done' } : toolCall('t1', 'task', { description: 'look', prompt: 'look around' })
  ]);
  const session = await createSession({ root, config, env: { ...process.env, HOME: root, OASIS_CONFIG_DIR: path.join(root, '.cfg') } });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'delegate', { autoApprove: true });
  const child = requests.find((payload) => payload.messages[0].content.includes('SUBAGENT MODE'));
  const parent = requests.find((payload) => !payload.messages[0].content.includes('SUBAGENT MODE'));
  assert.ok(child, 'the subagent sent a request');
  assert.equal(child.stream, true);
  assert.notEqual(parent.stream, true, 'a parent with no display keeps its old request shape');
});
