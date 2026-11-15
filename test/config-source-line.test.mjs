// `oasis config` / `/status` printed "Config file: PATH" even when no such
// file existed and OASIS_* environment variables supplied every setting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/oasis.mjs');

function run(home, extra) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_NO_UPDATE_CHECK: '1' };
  for (const key of Object.keys(env)) if ((key.startsWith('OASIS_') && key !== 'OASIS_NO_UPDATE_CHECK') || key.endsWith('_API_KEY') || key.endsWith('_BASE_URL')) delete env[key];
  Object.assign(env, extra);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'config'], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    child.stderr.on('data', (d) => { text += d; });
    child.on('close', () => resolve(text));
  });
}

test('oasis config says whether config.json exists and which env vars set the provider', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-config-source-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const envOnly = await run(home, { OASIS_BASE_URL: 'http://127.0.0.1:9/v1', OASIS_MODEL: 'm', OASIS_LOCAL_API_KEY: 'x' });
  assert.match(envOnly, /Config file: .*config\.json \(not created yet\)/);
  assert.match(envOnly, /Set by environment: OASIS_BASE_URL, OASIS_MODEL, OASIS_LOCAL_API_KEY\n/);
  assert.doesNotMatch(envOnly, /\bx\b.*masked|OASIS_LOCAL_API_KEY=x/);

  await mkdir(path.join(home, '.config', 'oasis'), { recursive: true });
  await writeFile(path.join(home, '.config', 'oasis', 'config.json'), JSON.stringify({ baseURL: 'http://127.0.0.1:9/v1', model: 'file-model', protocol: 'openai' }));
  const fileOnly = await run(home, {});
  assert.match(fileOnly, /Config file: .*config\.json\n/);
  assert.doesNotMatch(fileOnly, /not created yet|Set by environment/);
  const both = await run(home, { OASIS_MODEL: 'env-model' });
  assert.match(both, /Set by environment: OASIS_MODEL \(these override the file\)/);
});
