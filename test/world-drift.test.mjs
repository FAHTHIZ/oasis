import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, utimes, unlink, mkdir } from 'node:fs/promises';
import { captureWorld, compareWorld, driftNote, driftSummary, knownPaths, sanitizeWorld } from '../src/world-drift.mjs';
import { loadSession, saveSession } from '../src/sessions.mjs';

const call = (name, args, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const assistant = (...calls) => ({ role: 'assistant', content: null, tool_calls: calls });

async function repo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-drift-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/app.js'), 'v1\n');
  await writeFile(path.join(root, 'src/util.js'), 'u1\n');
  await writeFile(path.join(root, 'README.md'), '# r\n');
  git('add', '-A');
  git('commit', '-qm', 'first');
  const messages = [
    { role: 'system', content: 's' }, { role: 'user', content: 'look' },
    assistant(call('read_file', { path: 'src/app.js' }, 'a'), call('edit_file', { path: 'src/util.js', old_string: 'u1', new_string: 'u1' }, 'b')),
    assistant(call('read_file', { path: 'missing.txt' }, 'c'), call('read_file', { path: '../outside.txt' }, 'd'))
  ];
  return { root, git, messages, env: { ...process.env, OASIS_CONFIG_DIR: path.join(os.tmpdir(), 'oasis-drift-cfg-' + process.pid) } };
}

test('known paths come from file tool calls and patches, inside the workspace only', () => {
  const root = '/w';
  const messages = [
    assistant(call('read_file', { path: 'a.js' }), call('write_file', { path: '/w/b.js', content: '' }), call('read_file', { path: '/etc/passwd' })),
    assistant(call('apply_patch', { patch: '*** Begin Patch\n*** Update File: c.js\n@@\n-x\n+y\n*** Add File: d.js\n+z\n*** End Patch' })),
    assistant(call('run_command', { command: 'cat', args: ['e.js'] }), call('read_file', { path: 'a.js' }))
  ];
  assert.deepEqual(knownPaths(messages, root), ['b.js', 'c.js', 'd.js', 'a.js']);
});

test('nothing moved, or only mtimes moved: no drift', async (t) => {
  const { root, messages, env } = await repo(t);
  const world = await captureWorld(root, messages, { env });
  assert.equal(world.branch, 'main');
  assert.match(world.head, /^[0-9a-f]{40}$/);
  assert.deepEqual(Object.keys(world.files), ['src/app.js', 'src/util.js', 'missing.txt']);
  assert.equal(world.files['missing.txt'], null);
  assert.equal(await compareWorld(world, root, { env }), null);
  const later = new Date(Date.now() + 60_000);
  await utimes(path.join(root, 'src/app.js'), later, later);
  await writeFile(path.join(root, 'src/util.js'), 'u1\n');
  assert.equal(await compareWorld(world, root, { env }), null, 'same bytes are not drift');
});

test('edited, deleted and newly created known files are named', async (t) => {
  const { root, messages, env } = await repo(t);
  const world = await captureWorld(root, messages, { env });
  await writeFile(path.join(root, 'src/app.js'), 'v2 by someone else\n');
  await unlink(path.join(root, 'src/util.js'));
  await writeFile(path.join(root, 'missing.txt'), 'here now\n');
  await writeFile(path.join(root, 'README.md'), 'not known to the session\n');
  const drift = await compareWorld(world, root, { env });
  assert.deepEqual(drift.files, { changed: ['src/app.js'], deleted: ['src/util.js'], created: ['missing.txt'] });
  assert.equal(drift.head, undefined);
  const note = driftNote(drift);
  assert.match(note, /^<workspace-drift>The workspace changed since this conversation was last saved/);
  assert.match(note, /Changed: src\/app\.js\. Deleted: src\/util\.js\. Now exist \(were missing\): missing\.txt\./);
  assert.match(note, /read them again before relying on them/);
});

test('new commits, a branch switch and rewritten history are told apart', async (t) => {
  const { root, git, messages, env } = await repo(t);
  const world = await captureWorld(root, messages, { env });
  await writeFile(path.join(root, 'README.md'), '# r2\n');
  git('commit', '-qam', 'Update the readme');
  let drift = await compareWorld(world, root, { env });
  assert.equal(drift.head.relation, 'ahead');
  assert.equal(drift.head.count, 1);
  assert.match(drift.head.commits[0], /^[0-9a-f]+ Update the readme$/);
  assert.match(driftNote(drift), /1 new commit since then: [0-9a-f]+ Update the readme\./);

  git('checkout', '-q', '-b', 'feature');
  drift = await compareWorld(world, root, { env });
  assert.deepEqual(drift.branch, { from: 'main', to: 'feature' });
  assert.match(driftSummary(drift), /^\[session\] The workspace changed since this session was saved: The branch changed from main to feature\./);

  git('checkout', '-q', 'main');
  git('reset', '-q', '--hard', world.head);
  assert.equal(await compareWorld(world, root, { env }), null, 'back where it was');
  const ahead = await captureWorld(root, messages, { env });
  await writeFile(path.join(root, 'README.md'), '# r3\n');
  git('commit', '-qam', 'Third');
  const third = await captureWorld(root, messages, { env });
  git('reset', '-q', '--hard', 'HEAD~1');
  drift = await compareWorld(third, root, { env });
  assert.equal(drift.head.relation, 'behind');
  assert.match(driftNote(drift), /HEAD moved back 1 commit/);
  git('commit', '-q', '--amend', '-m', 'first, reworded');
  drift = await compareWorld(ahead, root, { env });
  assert.equal(drift.head.relation, 'other');
  assert.match(driftNote(drift), /not a descendant/);
});

test('saved fingerprints are sanitized on load', () => {
  assert.equal(sanitizeWorld(null), null);
  const clean = sanitizeWorld({ at: 'x', head: 'nothex', branch: 'b', dirty: -1, files: { 'a.js': 'h', '/etc/passwd': 'h', '../x': 'h', 'b.js': null, 'c.js': 5 } });
  assert.deepEqual(clean, { at: 'x', branch: 'b', files: { 'a.js': 'h', 'b.js': null } });
});

test('OASIS_WORLD_DRIFT=0 records and reports nothing', async (t) => {
  const { root, messages, env } = await repo(t);
  assert.equal(await captureWorld(root, messages, { env: { ...env, OASIS_WORLD_DRIFT: '0' } }), null);
  const world = await captureWorld(root, messages, { env });
  await writeFile(path.join(root, 'src/app.js'), 'changed\n');
  assert.equal(await compareWorld(world, root, { env: { ...env, OASIS_WORLD_DRIFT: '0' } }), null);
});

test('a resumed session starts its first turn with the drift note, once', async (t) => {
  const { createSession, runAgentTurn, closeSession } = await import('../src/agent.mjs');
  const { scriptedModel } = await import('./helpers/scripted-model.mjs');
  const { root, git, messages, env } = await repo(t);
  t.after(() => rm(env.OASIS_CONFIG_DIR, { recursive: true, force: true }));
  // Each assistant message is followed by its tool results.
  const live = { root, settings: {}, config: { model: 'm' } };
  live.messages = [messages[0], messages[1], messages[2], { role: 'tool', tool_call_id: 'a', content: 'v1' }, { role: 'tool', tool_call_id: 'b', content: 'ok' }, messages[3], { role: 'tool', tool_call_id: 'c', content: 'missing' }, { role: 'tool', tool_call_id: 'd', content: 'outside' }, { role: 'assistant', content: 'done' }];
  const saved = await saveSession(live, { env });
  const restored = await loadSession(root, saved.id, { env });
  assert.ok(restored.world && restored.world.files['src/app.js']);

  await writeFile(path.join(root, 'src/app.js'), 'v2 from the editor\n');
  git('commit', '-qam', 'Edit app from the editor');

  const { config, requests } = await scriptedModel(t, [{ content: 'ok' }, { content: 'ok again' }]);
  const session = await createSession({ root, config, restore: restored, env });
  t.after(() => closeSession(session));
  assert.deepEqual(session.worldDrift.files.changed, ['src/app.js']);
  await runAgentTurn(session, 'continue', { env });
  const first = requests[0].messages.filter((message) => message.role === 'user').at(-1).content;
  assert.match(first, /<workspace-drift>[\s\S]*1 new commit since then: [0-9a-f]+ Edit app from the editor\.[\s\S]*Changed: src\/app\.js\./);
  await runAgentTurn(session, 'and now?', { env });
  const second = requests[1].messages.filter((message) => message.role === 'user').at(-1).content;
  assert.doesNotMatch(second, /workspace-drift/);
});
