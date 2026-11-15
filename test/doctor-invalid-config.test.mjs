// With an unreadable config.json, `oasis doctor` said "CHECK — run oasis setup"
// and "Next step: run oasis setup to connect a model", hiding the parse error
// that every other command reports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/oasis.mjs');

test('oasis doctor names an unreadable config.json instead of asking for setup', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-doctor-badcfg-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, '.config', 'oasis'), { recursive: true });
  await writeFile(path.join(home, '.config', 'oasis', 'config.json'), '{"protocol":"openai", broken');
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_NO_UPDATE_CHECK: '1', NO_COLOR: '1' };
  for (const key of Object.keys(env)) if ((key.startsWith('OASIS_') && key !== 'OASIS_NO_UPDATE_CHECK') || key.endsWith('_API_KEY') || key.endsWith('_BASE_URL')) delete env[key];
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'doctor'], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    child.stderr.on('data', (d) => { text += d; });
    child.on('close', () => resolve(text));
  });
  assert.match(out, /Model connection: CHECK — Could not read Oasis configuration: .*config\.json/);
  assert.match(out, /Next step: fix the configuration file named above/);
  assert.doesNotMatch(out, /Next step: run oasis setup to connect a model/);
});
