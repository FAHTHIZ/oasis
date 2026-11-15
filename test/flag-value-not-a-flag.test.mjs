import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksLikeFlag } from '../src/cli.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/oasis.mjs');

function run(args, home) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') };
    for (const key of Object.keys(env)) if (/^OASIS_|_API_KEY$/.test(key)) delete env[key];
    const child = spawn(process.execPath, [CLI, ...args], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

test('lone options are recognised, ordinary values are not', () => {
  for (const v of ['-p', '--print', '--max-turns', '--max-turns=3', '-c']) assert.equal(looksLikeFlag(v), true, v);
  for (const v of ['gpt-5', 'claude-opus-4-6', '-', '-1', 'be terse', '- list items', 'a=b', '']) assert.equal(looksLikeFlag(v), false, v);
});

test('a flag that needs a value does not swallow the next option', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'oasis-flagvalue-'));
  // Before the fix `--model -p hi` used "-p" as the model id and ran "hi" as a task.
  const cases = [
    [['--model', '-p', 'hi'], /--model requires a model id/],
    [['--fallback-model', '--yes', '-p', 'hi'], /--fallback-model requires a value/],
    [['--append-system-prompt', '-p', 'hi'], /--append-system-prompt requires a value/],
    [['--add-dir', '-p', 'hi'], /--add-dir needs a directory/],
    [['--workspace', '-p', 'hi'], /--workspace requires a path/]
  ];
  for (const [args, pattern] of cases) {
    const { out } = await run(args, home);
    assert.match(out, pattern, args.join(' ') + '\n' + out);
  }
});
