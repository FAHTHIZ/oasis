import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { rewind, listCheckpoints } from '../src/checkpoints.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };

async function setup(t, script) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-ckpt-'));
  await writeFile(path.join(root, 'app.js'), 'const version = 1;\n');
  const model = await scriptedModel(t, script, { registerTeardown: false });
  let session = null;
  t.after(async () => {
    try {
      if (session) await closeSession(session);
    } finally {
      try {
        await model.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  session = await createSession({ root, config: model.config, settings });
  return { root, session };
}

test('rewind restores edited files, removes created files, and trims the conversation', async (t) => {
  let turn = 0;
  const { root, session } = await setup(t, [(payload, requests) => {
    const last = payload.messages.at(-1);
    if (last.role === 'user' && /first/.test(last.content)) { turn = 1; return toolCall('a1', 'edit_file', { path: 'app.js', old_string: 'version = 1', new_string: 'version = 2' }); }
    if (last.role === 'user' && /second/.test(last.content)) { turn = 2; return { content: null, tool_calls: [
      { id: 'b1', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'app.js', old_string: 'version = 2', new_string: 'version = 3' }) } },
      { id: 'b2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'new/notes.md', content: 'hello' }) } }
    ] }; }
    return { content: 'done turn ' + turn };
  }]);
  await runAgentTurn(session, 'first change', { autoApprove: true, approval: async () => true });
  const afterFirst = session.messages.length;
  await runAgentTurn(session, 'second change', { autoApprove: true, approval: async () => true });
  assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'const version = 3;\n');
  assert.equal(await readFile(path.join(root, 'new', 'notes.md'), 'utf8'), 'hello');
  const list = listCheckpoints(session);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0].files.sort(), ['app.js', 'new/notes.md']);

  const result = await rewind(session, 1);
  assert.deepEqual(result.restored, ['app.js']);
  assert.deepEqual(result.deleted, ['new/notes.md']);
  assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'const version = 2;\n');
  await assert.rejects(access(path.join(root, 'new', 'notes.md')));
  assert.equal(session.messages.length, afterFirst);
  assert.equal(listCheckpoints(session).length, 1);

  const again = await rewind(session, 1);
  assert.deepEqual(again.restored, ['app.js']);
  assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'const version = 1;\n');
  assert.equal(session.messages.length, 1);
});

test('code-only and chat-only rewinds, plus the /rewind command', async (t) => {
  const { root, session } = await setup(t, [(payload) => {
    const last = payload.messages.at(-1);
    if (last.role === 'user') return toolCall('c1', 'write_file', { path: 'app.js', content: 'changed\n' });
    return { content: 'ok' };
  }]);
  await runAgentTurn(session, 'rewrite app', { autoApprove: true, approval: async () => true });
  const length = session.messages.length;
  const listing = await runBuiltinCommand('rewind', '', { root, session });
  assert.match(listing.output, /1\. "rewrite app"\s+files: app\.js/);
  const codeOnly = await runBuiltinCommand('rewind', '1 code', { root, session });
  assert.match(codeOnly.output, /Restored: app\.js/);
  assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'const version = 1;\n');
  assert.equal(session.messages.length, length);
  const chatOnly = await rewind(session, 1, 'conversation');
  assert.equal(chatOnly.restored.length, 0);
  assert.equal(session.messages.length, 1);
});

test('parallel agents capturing the same file keep the first snapshot and count its bytes once', async (t) => {
  const { beginCheckpoint: begin, captureBeforeChange: capture } = await import('../src/checkpoints.mjs');
  const { mkdtemp: makeTemp, writeFile: write, rm: remove } = await import('node:fs/promises');
  const dir = await makeTemp(path.join(os.tmpdir(), 'oasis-cp-race-'));
  t.after(() => remove(dir, { recursive: true, force: true }));
  await write(path.join(dir, 'f.txt'), 'original\n');
  const session = { checkpoints: null };
  begin(session, 'edit f');
  // Subagents share the parent's checkpoint store; their captures overlap.
  const first = capture(session, dir, 'write_file', { path: 'f.txt' });
  const second = capture(session, dir, 'edit_file', { path: 'f.txt' });
  await first;
  await write(path.join(dir, 'f.txt'), 'changed by the first agent\n');
  await second;
  assert.equal(session.checkpoints.bytes, 'original\n'.length);
  assert.equal(String(session.checkpoints.turns.at(-1).files.get('f.txt').content), 'original\n');
});

test('/rewind N fork keeps the full conversation saved and continues from an earlier turn', async (t) => {
  const { root, session } = await setup(t, [(payload) => {
    const last = payload.messages.at(-1);
    if (last.role === 'user') return toolCall('c' + payload.messages.length, 'write_file', { path: 'app.js', content: 'v' + payload.messages.length + '\n' });
    return { content: 'ok' };
  }]);
  const env = { ...process.env, HOME: root, OASIS_CONFIG_DIR: path.join(root, '.config') };
  await runAgentTurn(session, 'first change', { autoApprove: true, approval: async () => true });
  const afterFirst = session.messages.length;
  await runAgentTurn(session, 'second change', { autoApprove: true, approval: async () => true });
  const fullLength = session.messages.length;
  const fileBefore = await readFile(path.join(root, 'app.js'), 'utf8');
  const result = await runBuiltinCommand('rewind', 'fork 1', { root, session, env });
  assert.match(result.output, /Forked from 1 turn back/);
  assert.match(result.output, /Files were not changed/);
  assert.ok(result.forked && result.forked.from !== result.forked.to);
  assert.equal(session.sessionId, result.forked.to);
  assert.equal(session.messages.length, afterFirst);
  assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), fileBefore);
  const { loadSession } = await import('../src/sessions.mjs');
  const original = await loadSession(root, result.forked.from, { env });
  assert.equal(original.messages.length, fullLength);
  const alt = await runBuiltinCommand('rewind', '1 fork', { root, session, env });
  assert.match(alt.output, /Forked from 1 turn back/);
});
