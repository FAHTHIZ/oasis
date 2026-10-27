import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { loadConfig, saveConfig, validateBaseUrl, getConfigPath } from '../src/config.mjs';
import { normalizePackageName, parseInstallIntent, resolveEcosystem } from '../src/installer.mjs';
import { executeTool, readWorkspaceFile, resolveWorkspacePath, runWorkspaceCommand, toolCount } from '../src/tools.mjs';
import { listBackups, restoreBackup } from '../src/backups.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { saveMcpServers, connectMcpServers, mcpToolDefinitions, callMappedMcpTool, closeMcpClients, validateMcpServerConfig } from '../src/mcp.mjs';
import { saveSession, loadSession, listSessions, deleteSession } from '../src/sessions.mjs';

async function temporaryDirectory(prefix = 'oasis-test-') {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

test('configuration validates HTTPS provider URLs and permits loopback HTTP', () => {
  assert.equal(validateBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.equal(validateBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1');
  assert.throws(() => validateBaseUrl('ftp://api.example.com/v1'), /HTTP and HTTPS/);
  assert.throws(() => validateBaseUrl('http://api.example.com/v1'), /must use HTTPS/);
  assert.throws(() => validateBaseUrl('https://user:pass@api.example.com/v1'), /must not include credentials/);
});

test('configuration is written outside the project and its API key is not included in summaries', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const configPath = path.join(tmp, 'cfg', 'config.json');
  await saveConfig({ baseURL: 'https://api.example.com/v1', model: 'example-model', apiKey: 'private-test-key' }, { configPath, env: {} });
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(saved.apiKey, 'private-test-key');
  const loaded = await loadConfig({ configPath, env: {} });
  assert.equal(loaded.configured, true);
  assert.equal(loaded.model, 'example-model');
  assert.equal(getConfigPath({ OASIS_CONFIG_DIR: tmp }, tmp), path.join(tmp, 'config.json'));
  if (process.platform !== 'win32') assert.equal((await stat(configPath)).mode & 0o777, 0o600);
});

test('configuration never reuses a stored API key at a changed provider URL', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const configPath = path.join(tmp, 'config.json');
  await saveConfig({ protocol: 'openai-compatible', baseURL: 'https://provider-one.example/v1', model: 'fixture', apiKey: 'provider-one-secret' }, { configPath, env: {} });
  const changed = await loadConfig({ configPath, env: { OASIS_BASE_URL: 'https://provider-two.example/v1' } });
  assert.equal(changed.apiKey, '');
  assert.equal(changed.configured, false);
  const same = await loadConfig({ configPath, env: {} });
  assert.equal(same.apiKey, 'provider-one-secret');
  const local = await loadConfig({ configPath, env: { OASIS_BASE_URL: 'http://localhost:11434/v1', OPENAI_API_KEY: 'remote-provider-secret' } });
  assert.equal(local.apiKey, '');
  assert.equal(local.configured, true);
});

test('plain-English installation requests are parsed without accepting command fragments', () => {
  assert.deepEqual(parseInstallIntent('install pnpm'), { packageName: 'pnpm', ecosystem: 'auto' });
  assert.deepEqual(parseInstallIntent('Please install ripgrep in yourself'), { packageName: 'ripgrep', ecosystem: 'auto' });
  assert.deepEqual(parseInstallIntent('install yourself'), { action: 'self' });
  assert.deepEqual(parseInstallIntent('install npm package @org/tool@1.2.0'), { packageName: '@org/tool@1.2.0', ecosystem: 'npm' });
  assert.deepEqual(parseInstallIntent('install global npm package @org/tool@1.2.0'), { packageName: '@org/tool@1.2.0', ecosystem: 'npm-global' });
  assert.equal(parseInstallIntent('install pnpm and configure the project'), null);
  assert.equal(parseInstallIntent('please explain how package installation works'), null);
});

test('package-name validation rejects shell metacharacters and local paths', () => {
  assert.equal(normalizePackageName('@org/tool@1.2.0'), '@org/tool@1.2.0');
  assert.throws(() => normalizePackageName('foo;rm -rf /'), /single package identifier/);
  assert.throws(() => normalizePackageName('../secret'), /single package identifier/);
  assert.throws(() => normalizePackageName('https://example.com/a.tgz'), /single package identifier/);
});

test('auto ecosystem selection differentiates common CLI tools and project libraries', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  assert.equal(resolveEcosystem('pnpm', 'auto', tmp), 'npm-global');
  assert.equal(resolveEcosystem('ripgrep', 'auto', tmp), 'system');
  await writeFile(path.join(tmp, 'package.json'), '{"name":"demo"}');
  assert.equal(resolveEcosystem('date-fns', 'auto', tmp), 'npm');
});

test('workspace path resolution blocks traversal, sensitive files, and escaping symlinks', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'workspace');
  const outside = path.join(tmp, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(root, 'README.md'), 'safe');
  await writeFile(path.join(root, '.env'), 'PRIVATE=secret');
  await writeFile(path.join(outside, 'secret.txt'), 'outside');
  await assert.rejects(resolveWorkspacePath(root, '../outside/secret.txt'), /outside the workspace/);
  await assert.rejects(readWorkspaceFile(root, '.env'), /sensitive/);
  assert.equal((await readWorkspaceFile(root, 'README.md')).content, 'safe');
  try {
    await symlink(outside, path.join(root, 'escaped'), 'dir');
    await assert.rejects(resolveWorkspacePath(root, 'escaped/secret.txt'), /symbolic link/);
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'ENOTSUP') throw error;
    t.diagnostic('Symlink check skipped because this platform does not permit directory symlinks.');
  }
});

test('workspace file edits create recoverable snapshots; explicit restore works', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'workspace');
  const config = path.join(tmp, 'oasis-config');
  await mkdir(root);
  await writeFile(path.join(root, 'note.txt'), 'before');
  const previous = process.env.OASIS_CONFIG_DIR;
  process.env.OASIS_CONFIG_DIR = config;
  t.after(() => { if (previous === undefined) delete process.env.OASIS_CONFIG_DIR; else process.env.OASIS_CONFIG_DIR = previous; });
  const result = await executeTool('write_file', { path: 'note.txt', content: 'after' }, { root });
  assert.equal(result.backedUpExistingFile, true);
  assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'after');
  const backups = await listBackups(root);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].relativePath, 'note.txt');
  const restored = await restoreBackup(root, backups[0].id);
  assert.equal(restored.path, 'note.txt');
  assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'before');
  const afterRestoreBackups = await listBackups(root);
  assert.equal(afterRestoreBackups.length, 2);
});

test('delete_file requires explicit approval and leaves the file intact when denied', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'workspace');
  await mkdir(root);
  await writeFile(path.join(root, 'keep.txt'), 'keep');
  const result = await executeTool('delete_file', { path: 'keep.txt' }, { root, approval: async () => false });
  assert.equal(result.approved, false);
  assert.equal(await readFile(path.join(root, 'keep.txt'), 'utf8'), 'keep');
});

test('command tool blocks destructive executable names and strips API keys from children', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  await assert.rejects(runWorkspaceCommand(tmp, 'rm', ['-rf', '.'], { autoApprove: true }), /blocked by Oasis safety policy/);
  const result = await runWorkspaceCommand(tmp, process.execPath, ['-e', 'process.stdout.write(process.env.OASIS_API_KEY || "not-present")'], {
    autoApprove: true,
    env: { ...process.env, OASIS_API_KEY: 'do-not-leak-this' }
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'not-present');
});

test('public URL fetch blocks loopback and private network addresses', async () => {
  await assert.rejects(executeTool('fetch_url', { url: 'http://127.0.0.1/' }, { root: process.cwd() }), /Private-network/);
  await assert.rejects(executeTool('fetch_url', { url: 'http://localhost/' }, { root: process.cwd() }), /Local and metadata/);
});

test('agent tool registry exposes a useful coding workflow tool set', () => {
  assert.ok(toolCount() >= 7);
});


test('agent completes an OpenAI-compatible tool cycle against a local fixture server', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'workspace');
  await mkdir(root);
  await writeFile(path.join(root, 'README.md'), '# Fixture project');
  let requests = 0;
  let secondRequest = null;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    requests++;
    const payload = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (requests === 1) {
      res.end(JSON.stringify({ choices: [{ message: {
        role: 'assistant',
        content: 'I will inspect the workspace first.',
        tool_calls: [{ id: 'fixture-call-1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } }]
      } }] }));
    } else {
      secondRequest = payload;
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'I found README.md and completed the inspection.' } }] }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const config = { baseURL: 'http://127.0.0.1:' + port + '/v1', model: 'fixture-model', apiKey: '', maxSteps: 4, maxCommandSeconds: 10 };
  const session = await createSession({ root, config });
  const transcript = [];
  const result = await runAgentTurn(session, 'List the files in this workspace.', { onText: (text) => transcript.push(text) });
  assert.equal(result.finished, true);
  assert.equal(result.toolCalls, 1);
  assert.equal(requests, 2);
  assert.ok(secondRequest.messages.some((message) => message.role === 'tool' && message.content.includes('README.md')));
  assert.ok(transcript.some((text) => text.includes('completed the inspection')));
});


test('native OpenAI Responses API can call an Oasis tool and replay the complete response items', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'workspace');
  await mkdir(root);
  await writeFile(path.join(root, 'README.md'), '# Responses fixture');
  let requests = 0;
  let authSeen = false;
  let firstPayload = null;
  let secondPayload = null;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    requests++;
    authSeen = authSeen || req.url === '/v1/responses' && req.headers.authorization === 'Bearer responses-fixture-key';
    if (requests === 1) firstPayload = payload;
    else secondPayload = payload;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (requests === 1) {
      res.end(JSON.stringify({
        id: 'resp_fixture_1',
        status: 'completed',
        output: [
          { id: 'msg_fixture_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will inspect the files.' }] },
          { id: 'fc_fixture_1', type: 'function_call', call_id: 'call_fixture_list', name: 'list_files', arguments: '{"path":"."}', status: 'completed' }
        ]
      }));
    } else {
      res.end(JSON.stringify({
        id: 'resp_fixture_2',
        status: 'completed',
        output: [{ id: 'msg_fixture_2', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The workspace contains README.md.' }] }]
      }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = {
    protocol: 'openai-responses',
    baseURL: 'http://127.0.0.1:' + server.address().port + '/v1',
    model: 'fixture-model',
    apiKey: 'responses-fixture-key',
    maxSteps: 4,
    maxCommandSeconds: 10
  };
  const session = await createSession({ root, config });
  const result = await runAgentTurn(session, 'List the files in this workspace.');
  assert.equal(result.finished, true);
  assert.equal(result.toolCalls, 1);
  assert.equal(requests, 2);
  assert.equal(authSeen, true);
  assert.equal(firstPayload.model, 'fixture-model');
  assert.equal(firstPayload.store, false);
  assert.ok(Array.isArray(firstPayload.input));
  assert.ok(firstPayload.tools.some((tool) => tool.type === 'function' && tool.name === 'list_files'));
  assert.ok(secondPayload.input.some((item) => item.type === 'function_call' && item.call_id === 'call_fixture_list'));
  assert.ok(secondPayload.input.some((item) => item.type === 'function_call_output' && item.call_id === 'call_fixture_list' && item.output.includes('README.md')));
  assert.equal(session.messages.at(-1).content, 'The workspace contains README.md.');
});

test('native Anthropic Messages API can call an Oasis tool and consume its result', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'workspace');
  await mkdir(root);
  await writeFile(path.join(root, 'README.md'), '# Anthropic fixture');
  let requests = 0;
  let authSeen = false;
  let secondRequest = null;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    requests++;
    authSeen = authSeen || (req.headers['x-api-key'] === 'anthropic-fixture-key' && req.headers['anthropic-version'] === '2023-06-01');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (requests === 1) {
      assert.ok(Array.isArray(payload.tools));
      assert.ok(payload.tools.some((tool) => tool.name === 'list_files' && tool.input_schema));
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'fixture', stop_reason: 'tool_use', content: [
        { type: 'text', text: 'I will inspect the workspace.' },
        { type: 'tool_use', id: 'anthropic-tool-1', name: 'list_files', input: { path: '.' } }
      ] }));
    } else {
      secondRequest = payload;
      res.end(JSON.stringify({ id: 'msg_2', type: 'message', role: 'assistant', model: 'fixture', stop_reason: 'end_turn', content: [
        { type: 'text', text: 'The workspace contains README.md.' }
      ] }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = { protocol: 'anthropic', baseURL: 'http://127.0.0.1:' + server.address().port, model: 'fixture-model', apiKey: 'anthropic-fixture-key', maxSteps: 4, maxCommandSeconds: 10 };
  const session = await createSession({ root, config });
  const result = await runAgentTurn(session, 'List the files in this workspace.');
  assert.equal(result.finished, true);
  assert.equal(result.toolCalls, 1);
  assert.equal(requests, 2);
  assert.equal(authSeen, true);
  assert.ok(secondRequest.messages.some((message) => message.role === 'user' && Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_result' && block.tool_use_id === 'anthropic-tool-1')));
  assert.equal(session.messages.at(-1).content, 'The workspace contains README.md.');
});


test('MCP stdio server exposes tools and requires per-call approval', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const configPath = path.join(tmp, 'mcp-servers.json');
  const script = [
    "let buffer = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    "  buffer += chunk;",
    "  let index;",
    "  while ((index = buffer.indexOf('\\n')) >= 0) {",
    "    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);",
    "    let message; try { message = JSON.parse(line); } catch { continue; }",
    "    if (message.id === undefined) continue;",
    "    let result = {};",
    "    if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };",
    "    if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo one message', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }] };",
    "    if (message.method === 'tools/call') result = { content: [{ type: 'text', text: 'pong ' + message.params.arguments.message }] };",
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');",
    "  }",
    "});"
  ].join('\n');
  validateMcpServerConfig({ name: 'fixture', command: process.execPath, args: ['-e', script], passEnv: [] });
  await saveMcpServers([{ name: 'fixture', command: process.execPath, args: ['-e', script], passEnv: [], enabled: true }], { configPath });
  const connected = await connectMcpServers({ configPath, root: tmp, env: { ...process.env, OASIS_API_KEY: 'must-not-be-passed-to-mcp' } });
  t.after(() => closeMcpClients(connected.clients));
  assert.equal(connected.failures.length, 0);
  const generated = mcpToolDefinitions(connected.clients);
  assert.ok(generated.definitions.some((definition) => definition.function.name === 'mcp_fixture_echo'));
  const session = { mcpClients: connected.clients, mcpToolMap: generated.map };
  const denied = await callMappedMcpTool(session, 'mcp_fixture_echo', { message: 'world' }, { approval: async () => false });
  assert.equal(denied.approved, false);
  const allowed = await callMappedMcpTool(session, 'mcp_fixture_echo', { message: 'world' }, { approval: async () => true });
  assert.equal(allowed.content, 'pong world');
});


test('restore refuses a symlink target, even when the link resolves outside the workspace', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'workspace');
  const outside = path.join(tmp, 'outside.txt');
  const config = path.join(tmp, 'oasis-config');
  await mkdir(root);
  await writeFile(path.join(root, 'safe.txt'), 'original');
  await writeFile(outside, 'outside secret');
  const previous = process.env.OASIS_CONFIG_DIR;
  process.env.OASIS_CONFIG_DIR = config;
  t.after(() => { if (previous === undefined) delete process.env.OASIS_CONFIG_DIR; else process.env.OASIS_CONFIG_DIR = previous; });
  const { executeTool } = await import('../src/tools.mjs');
  await executeTool('write_file', { path: 'safe.txt', content: 'snapshot source' }, { root });
  const backup = (await listBackups(root))[0];
  await rm(path.join(root, 'safe.txt'));
  try {
    await symlink(outside, path.join(root, 'safe.txt'));
    await assert.rejects(restoreBackup(root, backup.id), /symbolic link/);
    assert.equal(await readFile(outside, 'utf8'), 'outside secret');
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'ENOTSUP') throw error;
    t.diagnostic('Symlink restore protection skipped because this platform does not permit file symlinks.');
  }
});


test('saved sessions are opt-in, workspace-scoped, and removable', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'workspace');
  const config = path.join(tmp, 'private-config');
  await mkdir(root);
  const env = { ...process.env, OASIS_CONFIG_DIR: config };
  const session = {
    root,
    config: { protocol: 'openai-compatible', baseURL: 'https://provider.example/v1', model: 'fixture-model', apiKey: 'never-store-key-in-history' },
    messages: [
      { role: 'system', content: 'Test system context' },
      { role: 'user', content: 'Inspect the project' },
      { role: 'assistant', content: 'I will inspect files.' }
    ]
  };
  const saved = await saveSession(session, { env });
  assert.ok(saved.id.length >= 20);
  assert.equal(session.sessionId, saved.id);
  assert.equal((await listSessions(root, { env })).length, 1);
  const restored = await loadSession(root, saved.id, { env });
  assert.equal(restored.messages.length, 3);
  assert.equal(restored.messages[1].content, 'Inspect the project');
  const onDisk = await readFile(saved.path, 'utf8');
  assert.ok(!onDisk.includes('never-store-key-in-history'));
  if (process.platform !== 'win32') assert.equal((await stat(saved.path)).mode & 0o777, 0o600);
  const otherRoot = path.join(tmp, 'another-workspace');
  await mkdir(otherRoot);
  assert.deepEqual(await listSessions(otherRoot, { env }), []);
  const removed = await deleteSession(root, saved.id, { env });
  assert.equal(removed.deleted, true);
  assert.deepEqual(await listSessions(root, { env }), []);
});
