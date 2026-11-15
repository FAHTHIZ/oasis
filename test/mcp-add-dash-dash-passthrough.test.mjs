import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

async function home(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-mcp-dashdash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: dir, OASIS_CONFIG_DIR: path.join(dir, '.oasis'), OASIS_NO_UPDATE_CHECK: '1' };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  return { dir, env, run, file: path.join(dir, '.oasis', 'mcp-servers.json') };
}

// `-y` after `--` belongs to the server's command (npx -y PKG). The global
// option parser used to take it as OASIS's --yes, so the saved server lost it.
test('oasis mcp add NAME -- npx -y PKG keeps the server command\'s own -y', async (t) => {
  const { run, file } = await home(t);
  const result = run('mcp', 'add', 'fs', '--yes', '--', 'npx', '-y', '@modelcontextprotocol/server-filesystem', '.');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  const servers = Array.isArray(saved) ? saved : saved.servers || Object.values(saved.mcpServers || {});
  const fs = servers.find((server) => server.name === 'fs') || servers[0];
  assert.equal(fs.command, 'npx');
  assert.deepEqual(fs.args, ['-y', '@modelcontextprotocol/server-filesystem', '.']);
});

test('off a terminal, mcp add without --yes saves nothing and says to use --yes', async (t) => {
  const { run, file } = await home(t);
  const result = run('mcp', 'add', 'fs', '--', 'npx', '-y', 'pkg');
  assert.match(result.stdout, /Arguments: \["-y","pkg"\]/);
  assert.match(result.stdout, /Run the same command with --yes/);
  await assert.rejects(readFile(file, 'utf8'));
});

test('a -y after -- does not approve the change', async (t) => {
  const { run, file } = await home(t);
  run('mcp', 'add', 'fs', '--', 'npx', '-y', 'pkg');
  await assert.rejects(readFile(file, 'utf8'));
  const removed = run('--yes', 'mcp', 'remove', 'nothing-here');
  assert.notEqual(removed.status, 0);
});
