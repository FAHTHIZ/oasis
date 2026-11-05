import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveToolAlias, splitSimpleCommandLine, normalizeRunCommandCall } from '../src/tool-aliases.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';
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

test('splitSimpleCommandLine splits plain command lines and refuses shell syntax', () => {
  assert.deepEqual(splitSimpleCommandLine('python3 hello.py'), ['python3', 'hello.py']);
  assert.deepEqual(splitSimpleCommandLine('  npm   run "build all" --x=\'a b\' '), ['npm', 'run', 'build all', '--x=a b']);
  assert.deepEqual(splitSimpleCommandLine('git commit -m ""'), ['git', 'commit', '-m', '']);
  assert.deepEqual(splitSimpleCommandLine(`node -e 'console.log($x | 1)'`), ['node', '-e', 'console.log($x | 1)'], 'single quotes are literal');
  assert.deepEqual(splitSimpleCommandLine('python3 -c "print(6*7)"'), ['python3', '-c', 'print(6*7)']);
  for (const line of ['ls | wc -l', 'echo $HOME', 'cat a > b', 'ls *.py', 'a && b', 'echo "unbalanced', 'echo `id`', 'a\\ b', 'cd x; ls', '', 'FOO=1 node a.js', 'echo "$HOME"', 'a\nb']) {
    assert.equal(splitSimpleCommandLine(line), null, line);
  }
});

test('normalizeRunCommandCall rewrites whole command lines onto argv or run_shell', () => {
  const withShell = new Set(['run_command', 'run_shell']);
  const noShell = new Set(['run_command']);
  assert.deepEqual(normalizeRunCommandCall({ command: 'python3 hello.py' }, noShell), { name: 'run_command', args: { command: 'python3', args: ['hello.py'] } });
  assert.deepEqual(normalizeRunCommandCall({ command: 'npm test', args: ['--', '-u'], timeoutSeconds: 30 }, noShell).args, { command: 'npm', args: ['test', '--', '-u'], timeoutSeconds: 30 });
  assert.deepEqual(normalizeRunCommandCall({ command: 'ls | wc -l', timeoutSeconds: 9 }, withShell), { name: 'run_shell', args: { command: 'ls | wc -l', timeoutSeconds: 9 } });
  assert.equal(normalizeRunCommandCall({ command: 'ls | wc -l' }, noShell), null, 'no shell tool: keep the explanatory error');
  assert.equal(normalizeRunCommandCall({ command: 'ls | wc -l', args: ['x'] }, withShell), null, 'mixed forms are ambiguous');
  assert.equal(normalizeRunCommandCall({ command: 'git', args: ['status'] }, withShell), null, 'already argv');
  assert.equal(normalizeRunCommandCall({ command: 'a b', args: 'oops' }, withShell), null);
  assert.equal(resolveToolAlias('Bash', { command: 'node -v' }, noShell).args.command, 'node');
  assert.deepEqual(resolveToolAlias('Bash', { command: 'node -v' }, noShell).args.args, ['-v']);
});

test('a run_command call with a whole command line runs instead of failing', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-runcmd-line-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config, requests } = await scriptedModel(t, [toolCall('c1', 'run_command', { command: 'node -e "console.log(6*7)"' }), { content: 'done' }]);
  const session = await createSession({ root, config });
  await runAgentTurn(session, 'print 42', { approval: async () => true });
  const tool = requests[1].messages.find((m) => m.role === 'tool');
  assert.match(String(tool.content), /42/);
  const assistant = requests[1].messages.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { command: 'node', args: ['-e', 'console.log(6*7)'] });
});

test('run_command args sent as one string (JSON, JavaScript array or argument line) become an argv', async () => {
  const { normalizeRunCommandCall, parseArgsString } = await import('../src/tool-aliases.mjs');
  const js = normalizeRunCommandCall({ command: 'node', args: '["--input-type=module", "-e", `\nimport { f } from \'./src/lib.mjs\';\nconsole.log(f(1))\n`]' }, new Set());
  assert.deepEqual(js, { name: 'run_command', args: { command: 'node', args: ['--input-type=module', '-e', "\nimport { f } from './src/lib.mjs';\nconsole.log(f(1))\n"] } });
  assert.deepEqual(normalizeRunCommandCall({ command: 'npm', args: '["run", "check"]' }, new Set()).args.args, ['run', 'check']);
  assert.deepEqual(normalizeRunCommandCall({ command: 'npm', args: 'run check' }, new Set()).args.args, ['run', 'check']);
  assert.equal(parseArgsString('[`${HOME}`]'), null);
  assert.equal(parseArgsString('a | b'), null);
  assert.equal(normalizeRunCommandCall({ command: 'npm', args: 'test | tee out' }, new Set()), null);
});

test('the scratch-space prompt gives the import depth back to the project root', async () => {
  const { scratchPrompt } = await import('../src/scratch.mjs');
  assert.match(scratchPrompt('.oasis/scratch/19713cb2'), /e\.g\. "\.\.\/\.\.\/\.\.\/src\/…"/);
});
