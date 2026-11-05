import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { importStartupNotice } from '../src/importers.mjs';

test('people coming from another agent are told once what /import brings over', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-import-notice-'));
  const home = path.join(base, 'home');
  const root = path.join(base, 'proj');
  await mkdir(path.join(home, '.codex'), { recursive: true });
  await mkdir(root, { recursive: true });
  await writeFile(path.join(home, '.codex', 'config.toml'), '[mcp_servers.docs]\ncommand = "npx"\nargs = ["-y", "docs-mcp"]\n');
  await writeFile(path.join(home, '.codex', 'AGENTS.md'), 'Always run the tests.\n');
  const env = { HOME: home, OASIS_CONFIG_DIR: path.join(base, 'cfg') };
  const first = await importStartupNotice(root, { env, home });
  assert.match(first, /Codex/);
  assert.match(first, /1 MCP server/);
  assert.match(first, /\/import/);
  assert.equal(await importStartupNotice(root, { env, home }), '');
  await writeFile(path.join(home, '.codex', 'config.toml'), '[mcp_servers.docs]\ncommand = "npx"\n\n[mcp_servers.more]\ncommand = "uvx"\n');
  assert.match(await importStartupNotice(root, { env, home }), /2 MCP servers/);
  assert.equal(await importStartupNotice(root, { env: { ...env, OASIS_IMPORT_NOTICE: '0' }, home }), '');
});
