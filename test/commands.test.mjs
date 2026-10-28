import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadCustomCommands, resolveCustomCommand, expandFileMentions, renderCommandBody } from '../src/commands.mjs';
import { loadMemory, appendMemoryNote, memoryFiles } from '../src/memory.mjs';
import { runBuiltinCommand, createUsageTracker, recordUsage } from '../src/slash.mjs';
import { PermissionPolicy } from '../src/permissions.mjs';

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-cmd-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-home-'));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, '.config', 'oasis') };
  return { root, home, env };
}

test('custom commands load from .oasis and .claude with namespaces and front matter', async () => {
  const { root, home, env } = await workspace();
  await mkdir(path.join(root, '.oasis', 'commands', 'git'), { recursive: true });
  await mkdir(path.join(root, '.claude', 'commands'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'commands', 'git', 'pr.md'), '---\ndescription: Open a PR\nargument-hint: [title]\n---\nCreate a PR titled "$ARGUMENTS" on branch $1.\n');
  await writeFile(path.join(root, '.claude', 'commands', 'review.md'), '# Review the diff\nReview the current changes carefully.\n');
  const commands = await loadCustomCommands(root, { env, home });
  assert.ok(commands.has('git:pr'));
  assert.equal(commands.get('git:pr').description, 'Open a PR');
  assert.equal(commands.get('git:pr').argumentHint, '[title]');
  assert.equal(commands.get('review').description, 'Review the diff');
  const resolved = await resolveCustomCommand(root, '/git:pr fix-login now', { env, home });
  assert.match(resolved.prompt, /Create a PR titled "fix-login now" on branch fix-login\./);
  const review = await resolveCustomCommand(root, '/review focus on auth', { env, home });
  assert.match(review.prompt, /Arguments: focus on auth/);
  assert.equal(await resolveCustomCommand(root, '/missing', { env, home }), null);
});

test('placeholders render positional arguments', () => {
  assert.equal(renderCommandBody('a=$1 b=$2 all=$ARGUMENTS', 'x y').text, 'a=x b=y all=x y');
  assert.equal(renderCommandBody('none', '').usedArguments, false);
});

test('@mentions include workspace files but not secrets or outside paths', async () => {
  const { root } = await workspace();
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'app.js'), 'console.log(1);\n');
  await writeFile(path.join(root, '.env'), 'SECRET=1\n');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'oasis-out-'));
  await writeFile(path.join(outside, 'x.txt'), 'outside');
  await symlink(path.join(outside, 'x.txt'), path.join(root, 'link.txt'));
  const result = await expandFileMentions(root, 'Fix @src/app.js and read @.env and @link.txt, email me@example.com');
  assert.deepEqual(result.files, ['src/app.js']);
  assert.match(result.text, /<file path="src\/app.js">\nconsole.log\(1\);/);
  assert.doesNotMatch(result.text, /SECRET|outside/);
  const dir = await expandFileMentions(root, 'look at @src');
  assert.match(dir.text, /<directory path="src">\napp.js/);
});

test('hierarchical memory loads user, project, and local files and appends notes', async () => {
  const { root, home, env } = await workspace();
  await mkdir(path.join(home, '.config', 'oasis'), { recursive: true });
  await writeFile(path.join(home, '.config', 'oasis', 'OASIS.md'), 'Prefer tabs.\n');
  await writeFile(path.join(root, 'OASIS.md'), 'Use pnpm.\n@docs/style.md\n');
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs', 'style.md'), 'Style: short functions.\n');
  await writeFile(path.join(root, 'OASIS.local.md'), 'My port is 4000.\n');
  const memory = await loadMemory(root, { env, home });
  assert.match(memory, /User memory[\s\S]*Prefer tabs/);
  assert.match(memory, /Use pnpm[\s\S]*Style: short functions/);
  assert.match(memory, /Personal project memory[\s\S]*port is 4000/);
  const file = await appendMemoryNote(root, 'run npm test before committing', { env, home });
  assert.equal(file, path.join(root, 'OASIS.md'));
  assert.match(await readFile(file, 'utf8'), /- run npm test before committing\n$/);
  const userFile = await appendMemoryNote(root, 'answer briefly', { scope: 'user', env, home });
  assert.match(await readFile(userFile, 'utf8'), /Prefer tabs.\n- answer briefly\n$/);
  const files = await memoryFiles(root, { env, home });
  assert.ok(files.some((item) => item.label === 'local' && item.exists));
});

test('project memory symlinked outside the workspace is ignored', async () => {
  const { root, home, env } = await workspace();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'oasis-out-'));
  await writeFile(path.join(outside, 'secret.md'), 'TOP SECRET');
  await symlink(path.join(outside, 'secret.md'), path.join(root, 'OASIS.md'));
  assert.doesNotMatch(await loadMemory(root, { env, home }), /TOP SECRET/);
});

test('built-in slash commands report state and switch modes', async () => {
  const { root, env } = await workspace();
  const session = {
    root,
    config: { model: 'm1' },
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello there' }],
    toolDefinitions: [],
    permissions: new PermissionPolicy({ permissions: { allow: ['Bash(npm test:*)'] } }),
    sandbox: { enabled: false },
    hooks: {},
    background: new Map([['bg_1', { id: 'bg_1', status: 'running', exitCode: null, command: 'npm run dev' }]]),
    todos: [{ content: 'write tests', status: 'in_progress' }],
    agents: { explore: { name: 'explore', source: 'built-in', description: 'Read-only', tools: ['read_file'] } }
  };
  const usage = createUsageTracker();
  recordUsage(usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  const state = { root, session, env, usage, sessionOptions: {} };
  assert.match((await runBuiltinCommand('cost', '', state)).output, /15 tokens \(10 input, 5 output\) across 1 model requests/);
  assert.match((await runBuiltinCommand('context', '', state)).output, /Context: \[/);
  assert.match((await runBuiltinCommand('permissions', '', state)).output, /allow\s+Bash\(npm test:\*\)/);
  assert.match((await runBuiltinCommand('mode', 'plan', state)).output, /set to plan/);
  assert.equal(session.permissions.mode, 'plan');
  assert.match((await runBuiltinCommand('mode', 'bogus', state)).output, /Unknown mode/);
  assert.match((await runBuiltinCommand('model', 'm2', state)).output, /m2/);
  assert.equal(session.config.model, 'm2');
  assert.match((await runBuiltinCommand('bashes', '', state)).output, /bg_1\s+running\s+npm run dev/);
  assert.match((await runBuiltinCommand('todos', '', state)).output, /\[~\] write tests/);
  assert.match((await runBuiltinCommand('agents', '', state)).output, /explore \[built-in\]/);
  assert.match((await runBuiltinCommand('help', '', state)).output, /\/compact/);
  assert.equal(await runBuiltinCommand('nope', '', state), null);
});

test('/review, /security-review, /export, /resume and /mcp built-ins', async () => {
  const { root, env } = await workspace();
  const session = {
    root, config: { model: 'm1' }, toolDefinitions: [],
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'fix the bug' },
      { role: 'assistant', content: 'Looking.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'const a = 1;' },
      { role: 'assistant', content: 'Fixed it.' }
    ],
    mcpClients: new Map([['docs', { source: 'project', config: { type: 'http' }, tools: [{ name: 'search' }] }]]),
    mcpFailures: [{ name: 'db', error: 'DATABASE_URL is not set' }]
  };
  const state = { root, env, session };
  const review = await runBuiltinCommand('review', '', state);
  assert.match(review.prompt, /git diff HEAD/);
  assert.match(review.prompt, /read-only review/);
  const pr = await runBuiltinCommand('review', '#42', state);
  assert.match(pr.prompt, /gh pr diff 42/);
  const security = await runBuiltinCommand('security-review', 'main', state);
  assert.match(security.prompt, /git diff main/);
  assert.match(security.prompt, /injection/);

  const exported = await runBuiltinCommand('export', 'chat.md', state);
  assert.match(exported.output, /Exported 4 messages to chat\.md/);
  const markdown = await readFile(path.join(root, 'chat.md'), 'utf8');
  assert.match(markdown, /## User\n\nfix the bug/);
  assert.match(markdown, /Tool call: `read_file`/);
  assert.match(markdown, /## Oasis\n\nFixed it\./);
  await assert.rejects(runBuiltinCommand('export', 'chat.md', state), /already exists/);
  assert.match((await runBuiltinCommand('export', '../outside.md', state)).output, /inside the workspace/);

  assert.match((await runBuiltinCommand('resume', '', state)).output, /No saved sessions/);
  const mcp = await runBuiltinCommand('mcp', '', state);
  assert.match(mcp.output, /docs \[project, http\] 1 tool\(s\): search/);
  assert.match(mcp.output, /db - not connected: DATABASE_URL is not set/);

  await mkdir(path.join(root, '.oasis', 'commands'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'commands', 'review.md'), 'Team review checklist');
  assert.equal(await runBuiltinCommand('review', '', state), null);
});

test('/resume lists saved sessions and picks one by number or id prefix', async () => {
  const { root, env } = await workspace();
  const { saveSession } = await import('../src/sessions.mjs');
  const saved = await saveSession({ root, config: { model: 'm' }, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }] }, { env });
  const state = { root, env, session: null };
  assert.match((await runBuiltinCommand('resume', '', state)).output, new RegExp('1\\. ' + saved.id));
  assert.equal((await runBuiltinCommand('resume', '1', state)).resume, saved.id);
  assert.equal((await runBuiltinCommand('resume', saved.id.slice(0, 8), state)).resume, saved.id);
  assert.match((await runBuiltinCommand('resume', 'zzzz', state)).output, /No saved session/);
});
