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
  assert.match((await runBuiltinCommand('context', '', state)).output, /Estimated context: \[/);
  assert.match((await runBuiltinCommand('permissions', '', state)).output, /allow:?\s+Bash\(npm test:\*\)/);
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
  const numeric = await saveSession({ sessionId: '12345678-0000-4000-8000-000000000000', root, config: { model: 'm' }, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'x' }] }, { env });
  assert.equal((await runBuiltinCommand('resume', '12345678', state)).resume, numeric.id);
});

test('/resume and oasis sessions list hide archived sessions but still resume them by id', async (t) => {
  const { root, env } = await workspace();
  const { saveSession, setSessionArchived } = await import('../src/sessions.mjs');
  const kept = await saveSession({ root, config: { model: 'm' }, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'keep me' }] }, { env });
  const old = await saveSession({ root, config: { model: 'm' }, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'old work' }] }, { env });
  await setSessionArchived(root, old.id, true, { env });
  const state = { root, env, session: null };
  const listing = (await runBuiltinCommand('resume', '', state)).output;
  assert.match(listing, new RegExp('1\\. ' + kept.id));
  assert.doesNotMatch(listing, new RegExp(old.id));
  assert.equal((await runBuiltinCommand('resume', '1', state)).resume, kept.id);
  assert.equal((await runBuiltinCommand('resume', old.id, state)).resume, old.id, 'an archived session resumes by full id');
  assert.equal((await runBuiltinCommand('resume', old.id.slice(0, 8), state)).resume, old.id, 'and by id prefix');
  await setSessionArchived(root, kept.id, true, { env });
  assert.match((await runBuiltinCommand('resume', '', state)).output, /All saved sessions in this workspace are archived/);

  // oasis sessions list / archive / unarchive (writes to stdout).
  const { manageSessions } = await import('../src/cli-sessions.mjs');
  const saveEnv = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => { for (const key of Object.keys(env)) { if (key in saveEnv) process.env[key] = saveEnv[key]; else delete process.env[key]; } });
  const output = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk) => { output.push(String(chunk)); return true; };
  try {
    await manageSessions(root, ['unarchive', kept.id]);
    await manageSessions(root, ['list']);
    await manageSessions(root, ['list', '--archived']);
    await manageSessions(root, ['archive', kept.id]);
  } finally { process.stdout.write = write; }
  const text = output.join('');
  assert.match(text, new RegExp('Unarchived ' + kept.id));
  const [plain, archivedList] = text.split('Archived sessions for ');
  assert.match(plain, new RegExp(kept.id + '.*"keep me"'), 'each listed session shows its title so the user can tell them apart');
  assert.match(plain, /1 archived; oasis sessions list --archived shows them/);
  assert.match(archivedList, new RegExp(old.id));
  assert.doesNotMatch(archivedList.split('\n').slice(0, 2).join('\n'), new RegExp(kept.id));
  assert.match(text, new RegExp('Archived ' + kept.id + '\\. It is hidden'));
  await assert.rejects(manageSessions(root, ['archive']), /Usage: oasis sessions archive/);
});

test('@mentions with line ranges attach just those numbered lines', async () => {
  const { root } = await workspace();
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'big.js'), Array.from({ length: 100 }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n');
  const range = await expandFileMentions(root, 'Why does @src/big.js:10-12 fail?');
  assert.deepEqual(range.files, ['src/big.js:10-12']);
  assert.match(range.text, /<file path="src\/big.js" lines="10-12" total_lines="101">\n10\tline 10\n11\tline 11\n12\tline 12\n<\/file>/);
  assert.doesNotMatch(range.text, /line 13\b/);
  const github = await expandFileMentions(root, 'see @src/big.js#L5-L6.');
  assert.match(github.text, /lines="5-6"[^>]*>\n5\tline 5\n6\tline 6\n/);
  // The VS Code extension inserts @path#L10-20 for a selection.
  const vscode = await expandFileMentions(root, '@src/big.js#L7-8 explain');
  assert.match(vscode.text, /lines="7-8"[^>]*>\n7\tline 7\n8\tline 8\n<\/file>/);
  const focus = await expandFileMentions(root, 'what is @src/big.js:50');
  assert.match(focus.text, /lines="30-70" focus="50"/);
  const past = await expandFileMentions(root, '@src/big.js:500-510');
  assert.match(past.text, /only 101 lines/);
  const both = await expandFileMentions(root, '@src/big.js:1-2 and @src/big.js:99-100');
  assert.equal(both.files.length, 2);
  const plain = await expandFileMentions(root, 'whole @src/big.js');
  assert.match(plain.text, /<file path="src\/big.js">\nline 1\n/);
});

test('personal Codex and Gemini CLI instructions load as user memory, once', async () => {
  const { root, home, env } = await workspace();
  await mkdir(path.join(home, '.codex'), { recursive: true });
  await mkdir(path.join(home, '.gemini'), { recursive: true });
  await mkdir(path.join(home, '.claude'), { recursive: true });
  await writeFile(path.join(home, '.codex', 'AGENTS.md'), 'Codex habit: run make check.\n');
  await writeFile(path.join(home, '.claude', 'CLAUDE.md'), 'Shared personal rule.\n');
  await symlink(path.join(home, '.claude', 'CLAUDE.md'), path.join(home, '.gemini', 'GEMINI.md'));
  const memory = await loadMemory(root, { env: { ...env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') }, home });
  assert.match(memory, /Codex habit: run make check/);
  assert.equal(memory.split('Shared personal rule.').length - 1, 1, 'a symlinked copy is not loaded twice');
  const off = await loadMemory(root, { env: { ...env, HOME: home, OASIS_OTHER_AGENT_RULES: '0' }, home });
  assert.doesNotMatch(off, /Codex habit/);
});

test('Claude Code auto memory for the repository is imported, including from a worktree', async () => {
  const { claudeProjectDirName, claudeProjectRoot } = await import('../src/memory.mjs');
  const { root, home, env } = await workspace();
  await mkdir(path.join(root, '.git'), { recursive: true });
  const claudeHome = path.join(home, '.claude');
  const memDir = path.join(claudeHome, 'projects', claudeProjectDirName(root), 'memory');
  await mkdir(memDir, { recursive: true });
  await writeFile(path.join(memDir, 'MEMORY.md'), '- [Testing](feedback_testing.md) - integration tests hit a real DB\n');
  await writeFile(path.join(memDir, 'feedback_testing.md'), '---\nname: testing\n---\nNever mock the database in integration tests.\n');
  const e = { ...env, CLAUDE_CONFIG_DIR: claudeHome };
  const memory = await loadMemory(root, { env: e, home });
  assert.match(memory, /Claude Code auto memory for this repository/);
  assert.match(memory, /integration tests hit a real DB/);
  assert.match(memory, /Never mock the database/);
  // A linked worktree shares the main checkout's memory, as in Claude Code.
  const wt = await mkdtemp(path.join(os.tmpdir(), 'oasis-wt-'));
  await writeFile(path.join(wt, '.git'), 'gitdir: ' + path.join(root, '.git', 'worktrees', 'feature') + '\n');
  assert.equal(await claudeProjectRoot(wt), root);
  assert.match(await loadMemory(wt, { env: e, home }), /Never mock the database/);
  assert.doesNotMatch(await loadMemory(root, { env: { ...e, OASIS_IMPORT_CLAUDE_MEMORY: '0' }, home }), /Never mock the database/);
  assert.equal(claudeProjectDirName('/home/me/my.repo'), '-home-me-my-repo');
});

test('an @folder mention with many entries says how many were not listed', async () => {
  const { root } = await workspace();
  await mkdir(path.join(root, 'many'));
  for (let i = 0; i < 520; i++) await writeFile(path.join(root, 'many', 'f' + String(i).padStart(3, '0') + '.txt'), '');
  const dir = await expandFileMentions(root, 'look at @many');
  assert.match(dir.text, /f499\.txt\n\[20 more entries; use list_files to see them\]\n<\/directory>/);
});
