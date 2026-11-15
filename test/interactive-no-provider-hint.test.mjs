import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

// Inside the interactive prompt /setup connects a model; the banner and the
// reply to a task used to tell the user to exit and run `oasis setup`.
test('with no model, the interactive prompt points to /setup, not to leaving the session', { skip: process.platform !== 'linux' || spawnSync('script', ['--version']).error ? 'needs script(1) on Linux' : false, timeout: 60000 }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-no-provider-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^OASIS_|_API_KEY$|^OPENAI_|^ANTHROPIC_|^GEMINI_|^GOOGLE_|^OLLAMA_/.test(key)));
  Object.assign(env, { HOME: home, OASIS_CONFIG_DIR: path.join(home, '.oasis'), OASIS_SIMPLE_INPUT: '1', OASIS_NO_UPDATE_CHECK: '1', OASIS_DISABLE_THEME_RELOAD: '1' });
  const command = [process.execPath, cli].map((part) => JSON.stringify(part)).join(' ');
  const child = spawn('script', ['-qfec', command, '/dev/null'], { cwd: home, env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const timer = setTimeout(() => child.kill(), 40000);
  let step = 0;
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      if (step === 0 && /Paste here/.test(out)) { step = 1; child.stdin.write('later\n'); }
      if (step <= 1 && /not set up yet/.test(out)) { step = 2; setTimeout(() => child.stdin.write('fix the bug\n'), 300); }
      if (/needs a model provider/.test(out)) { clearInterval(iv); child.stdin.end('/exit\n'); resolve(); }
    }, 50);
    child.on('exit', () => { clearInterval(iv); resolve(); });
  });
  await new Promise((resolve) => child.exitCode !== null ? resolve() : child.on('exit', resolve));
  clearTimeout(timer);
  assert.match(out, /not set up yet · type \/setup/, out);
  assert.match(out, /needs a model provider for general coding tasks\. Type \/setup to connect one/, out);
  assert.doesNotMatch(out, /exit and run oasis setup|Run oasis setup first/, out);
});
