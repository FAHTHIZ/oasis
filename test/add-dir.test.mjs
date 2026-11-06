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

test('additional directories keep credential folders out and protect their git hooks and config', async (t) => {
  // Regression: --add-dir ~/.aws was accepted and its plainly named
  // credentials file read with no check, and write_file under --yes put a
  // .git/hooks/pre-commit into an added project without the protected prompt.
  const { base, root, lib, env } = await dirs(t);
  const aws = path.join(base, '.aws');
  await mkdir(aws);
  await writeFile(path.join(aws, 'credentials'), '[default]\naws_secret_access_key=x\n');
  await mkdir(path.join(lib, 'deploy', '.aws'), { recursive: true });
  await writeFile(path.join(lib, 'deploy', '.aws', 'credentials'), 'x');
  const added = await setAdditionalDirectories(root, [aws, lib]);
  assert.deepEqual(added.accepted, [lib]);
  assert.match(added.rejected[0].error, /credentials/);
  await assert.rejects(executeTool('read_file', { path: path.join(aws, 'credentials') }, { root, env }), /outside the workspace/);
  await assert.rejects(executeTool('read_file', { path: '../lib/deploy/.aws/credentials' }, { root, env }), /sensitive/);

  await mkdir(path.join(lib, '.git', 'hooks'), { recursive: true });
  const { scriptedModel, toolCall } = await import('./helpers/scripted-model.mjs');
  const { runAgentTurn } = await import('../src/agent.mjs');
  const { existsSync } = await import('node:fs');
  const { config } = await scriptedModel(t, [
    toolCall('w1', 'write_file', { path: path.join(lib, '.git', 'hooks', 'pre-commit'), content: '#!/bin/sh\necho owned\n' }),
    toolCall('w2', 'write_file', { path: '../lib/.mcp.json', content: '{}' }),
    { content: 'done' }
  ]);
  const session = await createSession({ root, config: { ...config, maxSteps: 5 }, env, addDirs: [lib] });
  t.after(() => closeSession(session));
  const prompts = [];
  await runAgentTurn(session, 'go', { autoApprove: true, approval: async (message) => { prompts.push(String(message)); return false; } });
  assert.equal(existsSync(path.join(lib, '.git', 'hooks', 'pre-commit')), false, 'hook written in an added directory');
  assert.equal(existsSync(path.join(lib, '.mcp.json')), false, '.mcp.json written in an added directory');
  assert.equal(prompts.length, 2);
});
