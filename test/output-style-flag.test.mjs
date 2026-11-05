import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scriptedModel } from './helpers/scripted-model.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

async function run(t, args) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-style-flag-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { config, requests } = await scriptedModel(t, [{ content: 'ok' }]);
  const child = spawn(process.execPath, [CLI, '-C', home, ...args], { env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  return { code, stderr, requests };
}

const systemText = (request) => request.messages.filter((message) => message.role === 'system').map((message) => String(message.content)).join('\n');

for (const args of [['--output-style', 'explanatory'], ['--output-style=explanatory']]) {
  test('oasis ' + args.join(' ') + ' applies the style to the session', async (t) => {
    const { code, stderr, requests } = await run(t, [...args, '-p', 'hi']);
    assert.equal(code, 0, stderr);
    assert.match(systemText(requests[0]), /Output style: explanatory/);
  });
}

test('--output-style without a name is an error', async (t) => {
  const { code, stderr } = await run(t, ['-p', 'hi', '--output-style']);
  assert.notEqual(code, 0);
  assert.match(stderr, /--output-style requires a value/);
});
