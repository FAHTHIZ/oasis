import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveToolAlias } from '../src/tool-aliases.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';

const TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'run_shell', 'run_command', 'glob_files', 'grep', 'list_files', 'todo_write', 'command_output']);

test('maps Claude Code tool names and argument shapes', () => {
  assert.deepEqual(resolveToolAlias('Read', { file_path: 'a.js', offset: 2 }, TOOLS), { name: 'read_file', args: { path: 'a.js', offset: 2 }, aliasedFrom: 'Read' });
  assert.deepEqual(resolveToolAlias('Bash', { command: 'npm test', timeout: 300000 }, TOOLS).args, { command: 'npm test', timeoutSeconds: 300 });
  assert.deepEqual(resolveToolAlias('Glob', { pattern: '**/*.ts', path: 'src' }, TOOLS).args, { pattern: 'src/**/*.ts' });
  assert.equal(resolveToolAlias('BashOutput', { bash_id: 'bg_1' }, TOOLS).args.id, 'bg_1');
  assert.equal(resolveToolAlias('ReadFile', { path: 'a' }, TOOLS).name, 'read_file');
  assert.equal(resolveToolAlias('read_file', {}, TOOLS), null, 'valid names are untouched');
});

test('unknown names get did-you-mean suggestions', () => {
  assert.match(resolveToolAlias('read_files', {}, TOOLS).error, /Did you mean: read_file/);
  assert.match(resolveToolAlias('totally_made_up', {}, TOOLS).error, /There is no tool named "totally_made_up"\. Only call/);
});

test('an agent calling Read with file_path just works', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'notes.txt'), 'hello from notes\n');
  const payloads = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    payloads.push(JSON.parse(body));
    const message = payloads.length === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"notes.txt"}' } }, { id: 'c2', type: 'function', function: { name: 'reed_file', arguments: '{}' } }] }
      : { role: 'assistant', content: 'done' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 } });
  await runAgentTurn(session, 'Read notes.txt');
  const tools = payloads[1].messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
  assert.match(tools[0], /hello from notes/);
  assert.match(tools[1], /Did you mean: read_file/);
  const assistant = payloads[1].messages.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.equal(assistant.tool_calls[0].function.name, 'read_file', 'history is rewritten consistently');
});
