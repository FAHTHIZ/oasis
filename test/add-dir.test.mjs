import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises';
import { executeTool, setAdditionalDirectories, resolveWorkspacePath } from '../src/tools.mjs';
import { createSession, closeSession } from '../src/agent.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';

async function dirs(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'oasis-adddir-')));
  t.after(async () => { await setAdditionalDirectories(path.join(base, 'app'), []).catch(() => {}); await rm(base, { recursive: true, force: true }); });
  const root = path.join(base, 'app');
  const lib = path.join(base, 'lib');
  const secret = path.join(base, 'secret');
  await mkdir(root); await mkdir(lib); await mkdir(secret);
  await writeFile(path.join(lib, 'util.js'), 'export const a = 1;\n');
  await writeFile(path.join(lib, '.env'), 'TOKEN=x');
  await writeFile(path.join(secret, 'keys.txt'), 'nope');
  await symlink(path.join(secret, 'keys.txt'), path.join(lib, 'link.txt'));
  return { base, root, lib, secret, env: { ...process.env, HOME: base, OASIS_CONFIG_DIR: path.join(base, 'cfg') } };
}

test('additional directories allow reads and edits but keep secrets and symlink escapes blocked', async (t) => {
  const { root, lib, secret, env } = await dirs(t);
  await assert.rejects(resolveWorkspacePath(root, '../lib/util.js'), /outside the workspace/);
  const added = await setAdditionalDirectories(root, ['../lib', '../missing', '/']);
  assert.deepEqual(added.accepted, [lib]);
  assert.deepEqual(added.rejected.map((item) => item.dir), ['../missing', '/']);

  const read = await executeTool('read_file', { path: path.join(lib, 'util.js') }, { root, env });
  assert.match(read.content, /export const a = 1/);
  assert.equal(read.path, '../lib/util.js');
  const edited = await executeTool('edit_file', { path: '../lib/util.js', old_string: 'a = 1', new_string: 'a = 2' }, { root, env, autoApprove: true });
  assert.equal(edited.changed, true);
  assert.match(await readFile(path.join(lib, 'util.js'), 'utf8'), /a = 2/);

  await assert.rejects(executeTool('read_file', { path: '../lib/.env' }, { root, env }), /sensitive/);
  await assert.rejects(executeTool('read_file', { path: '../lib/link.txt' }, { root, env }), /symbolic link/);
  await assert.rejects(executeTool('read_file', { path: path.join(secret, 'keys.txt') }, { root, env }), /outside the workspace/);
  await assert.rejects(resolveWorkspacePath(root, '../lib/util.js', { workspaceOnly: true }), /outside the workspace/);
});

test('createSession addDirs and /add-dir register directories and tell the model', async (t) => {
  const { root, lib, secret, env } = await dirs(t);
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'x', apiKey: '' };
  const session = await createSession({ root, config, env, addDirs: [lib] });
  t.after(() => closeSession(session));
  assert.deepEqual(session.additionalDirectories, [lib]);
  assert.match(session.messages[0].content, new RegExp('Additional working directories[\\s\\S]*' + lib.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const sessionOptions = {};
  const result = await runBuiltinCommand('add-dir', secret, { root, env, session, sessionOptions });
  assert.match(result.output, /Added/);
  assert.deepEqual(session.additionalDirectories, [lib, secret]);
  assert.match(session.messages[0].content, /Additional working directory added/);
  assert.match((await runBuiltinCommand('add-dir', '', { root, env, session, sessionOptions })).output, /lib[\s\S]*secret/);
  assert.match((await runBuiltinCommand('add-dir', '../nowhere', { root, env, session, sessionOptions })).output, /does not exist/);
});
