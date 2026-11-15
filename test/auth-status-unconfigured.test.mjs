// `oasis auth status` on a fresh install reported "apiProvider": "api.openai.com"
// and model "gpt-6.1-sol" (built-in defaults nobody chose), and a saved keyless
// endpoint (one that needs no key) reported loggedIn false although Oasis used it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authStatus } from '../src/auth-cli.mjs';

async function home(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, env: { HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: path.join(dir, '.config'), PATH: process.env.PATH } };
}

test('auth status with nothing configured does not report default provider or model', async (t) => {
  const { env } = await home(t);
  const s = await authStatus(env);
  assert.equal(s.loggedIn, false);
  assert.equal(s.authMethod, 'none');
  assert.equal(s.apiProvider, null);
  assert.equal(s.model, null);
  assert.equal(s.baseURL, null);
});

test('a saved keyless endpoint counts as connected', async (t) => {
  const { dir, env } = await home(t);
  await mkdir(path.join(dir, '.config', 'oasis'), { recursive: true });
  await writeFile(path.join(dir, '.config', 'oasis', 'config.json'), JSON.stringify({ protocol: 'openai', baseURL: 'https://models.example.test/v1', model: 'm1', keyless: true }));
  const s = await authStatus(env);
  assert.equal(s.loggedIn, true, JSON.stringify(s));
  assert.equal(s.authMethod, 'keyless');
  assert.equal(s.model, 'm1');
});
