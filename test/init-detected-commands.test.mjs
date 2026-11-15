// `oasis init` wrote the same generic template everywhere ("Run relevant
// checks"), even when package.json named the project's test and lint
// commands. It now lists the commands it can see on disk, and only those.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectProjectCommands } from '../src/project-commands.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/oasis.mjs');

function oasis(args, cwd) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: cwd, USERPROFILE: cwd, XDG_CONFIG_HOME: path.join(cwd, '.config'), OASIS_NO_UPDATE_CHECK: '1' };
    for (const key of Object.keys(env)) if (key.startsWith('OASIS_') && key !== 'OASIS_NO_UPDATE_CHECK') delete env[key];
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

test('oasis init lists the project commands found on disk', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-init-cmds-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test', lint: 'eslint .', build: 'vite build', typecheck: 'tsc --noEmit', dev: 'vite' } }));
  await writeFile(path.join(dir, 'pnpm-lock.yaml'), '');
  const r = await oasis(['init'], dir);
  assert.equal(r.code, 0, r.out);
  const text = await readFile(path.join(dir, 'OASIS.md'), 'utf8');
  assert.match(text, /## Commands/);
  assert.match(text, /- Test: `pnpm test`/);
  assert.match(text, /- Lint: `pnpm run lint`/);
  assert.match(text, /- Build: `pnpm run build`/);
  assert.match(text, /- Type check: `pnpm run typecheck`/);
  assert.match(text, /- Dev server: `pnpm run dev`/);
  assert.match(r.out, /\/init/, 'points to the model-written guide');
});

test('project command detection covers Python, Go, Rust and Make, and stays empty when nothing is found', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-init-langs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await detectProjectCommands(dir), []);
  await writeFile(path.join(dir, 'go.mod'), 'module x\n');
  await writeFile(path.join(dir, 'Cargo.toml'), '[package]\nname="x"\n');
  await writeFile(path.join(dir, 'pyproject.toml'), '[tool.ruff]\n');
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'Makefile'), 'build:\n\tcc x.c\ntest: build\n\t./run\n.PHONY: build test\n');
  const lines = (await detectProjectCommands(dir)).map((item) => item.label + ': ' + item.command);
  assert.ok(lines.includes('Test (Go): go test ./...'), lines.join('\n'));
  assert.ok(lines.includes('Test (Rust): cargo test'), lines.join('\n'));
  assert.ok(lines.includes('Test (Python): python3 -m pytest'), lines.join('\n'));
  assert.ok(lines.includes('Lint (Python): ruff check .'), lines.join('\n'));
  assert.ok(lines.includes('Make targets: make build, make test'), lines.join('\n'));
});
