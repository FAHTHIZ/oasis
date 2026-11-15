// `oasis undo` (or cost, usage, compact, logout …) used to go to the model as
// a one-word task: with a provider set, the agent was asked to "undo" with no
// context and could run git commands to do it. These words are chat commands,
// so the CLI now says to type them as /undo inside a chat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatOnlyCommand } from '../src/cli.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/oasis.mjs');

function oasis(args, home) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_NO_UPDATE_CHECK: '1' };
    for (const key of Object.keys(env)) if ((key.startsWith('OASIS_') && key !== 'OASIS_NO_UPDATE_CHECK') || key.endsWith('_API_KEY') || key.endsWith('_BASE_URL')) delete env[key];
    // A configured (unreachable) provider: the word must not reach it.
    Object.assign(env, { OASIS_PROTOCOL: 'openai', OASIS_BASE_URL: 'http://127.0.0.1:9/v1', OASIS_MODEL: 'm', OASIS_LOCAL_API_KEY: 'x' });
    const child = spawn(process.execPath, [CLI, ...args], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

test('a chat-only command given as the only argument points to the slash command', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-chatcmd-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const word of ['undo', 'cost', 'usage', 'compact', 'logout', 'rewind', 'export']) {
    const r = await oasis([word], home);
    assert.equal(r.code, 1, word + ': ' + r.out);
    assert.match(r.out, new RegExp('/' + word + '\\b'), word + ': ' + r.out);
    assert.match(r.out, /oasis -c/, word);
    assert.doesNotMatch(r.out, /Oasis>|ECONNREFUSED|could not reach/i, word);
  }
});

test('task-like words and sentences still go to the agent', () => {
  for (const args of [['fix'], ['review'], ['commit'], ['test'], ['simplify'], ['undo', 'the', 'last', 'commit'], ['/undo']]) {
    assert.equal(chatOnlyCommand(args), '', args.join(' '));
  }
  assert.equal(chatOnlyCommand(['Undo']), 'undo');
});
