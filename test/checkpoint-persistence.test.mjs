import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { listCheckpoints, rewind, loadCheckpoints, saveCheckpoints } from '../src/checkpoints.mjs';
import { saveSession, loadSession, deleteSession, checkpointDirectory } from '../src/sessions.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-ckpt-persist-'));
  const config = await mkdtemp(path.join(os.tmpdir(), 'oasis-ckpt-config-'));
  const env = { ...process.env, OASIS_CONFIG_DIR: config };
  await writeFile(path.join(root, 'app.js'), 'const version = 1;\n');
  const model = await scriptedModel(t, [(payload) => {
    const last = payload.messages.at(-1);
    if (last.role === 'user' && /first/.test(last.content)) return toolCall('a1', 'edit_file', { path: 'app.js', old_string: 'version = 1', new_string: 'version = 2' });
    if (last.role === 'user' && /second/.test(last.content)) return { content: null, tool_calls: [
      { id: 'b1', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'app.js', old_string: 'version = 2', new_string: 'version = 3' }) } },
      { id: 'b2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'notes.md', content: 'hello' }) } }
    ] };
    return { content: 'done' };
  }], { registerTeardown: false });
  const sessions = [];
  t.after(async () => {
    for (const session of sessions) await closeSession(session).catch(() => {});
    await model.close();
    await rm(root, { recursive: true, force: true });
    await rm(config, { recursive: true, force: true });
  });
  const open = async (restore = null) => {
    const session = await createSession({ root, config: model.config, settings, env, restore });
    sessions.push(session);
    return session;
  };
  return { root, env, open };
}

test('checkpoints survive saving and resuming a session, so /rewind still works', async (t) => {
  const { root, env, open } = await setup(t);
  const first = await open();
  await runAgentTurn(first, 'first change', { autoApprove: true, approval: async () => true });
  await runAgentTurn(first, 'second change', { autoApprove: true, approval: async () => true });
  const saved = await saveSession(first, { env });
  const directory = checkpointDirectory(root, saved.id, env);
  const blobs = await readdir(path.join(directory, 'blobs'));
  // Original app.js (v1), app.js before turn 2 (v2); notes.md did not exist.
  assert.equal(blobs.length, 2);

  const restored = await loadSession(root, saved.id, { env });
  const resumed = await open(restored);
  const list = listCheckpoints(resumed);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0].files.sort(), ['app.js', 'notes.md']);
  const messagesBefore = resumed.messages.length;

  const result = await rewind(resumed, 1);
  assert.deepEqual(result.restored, ['app.js']);
  assert.deepEqual(result.deleted, ['notes.md']);
  assert.equal(result.conversationUnavailable, false);
  assert.ok(result.messagesRemoved > 0 && resumed.messages.length < messagesBefore);
  assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'const version = 2;\n');
  await assert.rejects(access(path.join(root, 'notes.md')));

  // Saving again drops the rewound turn and its no-longer-needed blob.
  await saveSession(resumed, { env });
  assert.equal((await readdir(path.join(directory, 'blobs'))).length, 1);
  assert.equal((await loadCheckpoints(directory)).turns.length, 1);

  await deleteSession(root, saved.id, { env });
  await assert.rejects(access(directory));
});

test('OASIS_PERSIST_CHECKPOINTS=0 keeps checkpoints in memory only', async (t) => {
  const { root, env, open } = await setup(t);
  env.OASIS_PERSIST_CHECKPOINTS = '0';
  const session = await open();
  await runAgentTurn(session, 'first change', { autoApprove: true, approval: async () => true });
  const saved = await saveSession(session, { env });
  await assert.rejects(access(checkpointDirectory(root, saved.id, env)));
  const resumed = await open(await loadSession(root, saved.id, { env }));
  assert.equal(listCheckpoints(resumed).length, 0);
});

test('tampered or unsafe checkpoint entries are not restored', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oasis-ckpt-tamper-'));
  try {
    const session = { checkpoints: { turns: [{ userMessage: { role: 'user', content: 'go' }, prompt: 'go', createdAt: 'x', files: new Map([['a.txt', { existed: true, content: Buffer.from('original') }]]) }], bytes: 8 } };
    await saveCheckpoints(session, directory);
    const [blob] = await readdir(path.join(directory, 'blobs'));
    await writeFile(path.join(directory, 'blobs', blob), 'changed by someone else');
    const index = JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8'));
    index.turns[0].files.push({ path: '../outside.txt', existed: false }, { path: '/etc/passwd', existed: false });
    await writeFile(path.join(directory, 'index.json'), JSON.stringify(index));
    const loaded = await loadCheckpoints(directory);
    const files = loaded.turns[0].files;
    assert.deepEqual([...files.keys()], ['a.txt']);
    assert.equal(files.get('a.txt').skipped, true);
    assert.equal(files.get('a.txt').content, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
