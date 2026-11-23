import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { parse as parseToml } from 'smol-toml';
import { parseJsonc } from '../src/importers.mjs';
import { shareMcp, formatShareReport, SHARE_TARGETS } from '../src/mcp-share.mjs';

async function dirs(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-share-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo'); const home = path.join(base, 'home');
  await mkdir(root, { recursive: true }); await mkdir(home, { recursive: true });
  return { root, home, env: { PATH: '', XDG_CONFIG_HOME: path.join(home, '.config') } };
}
const launch = { command: 'oasis', args: ['mcp', 'serve'] };

test('share registers oasis mcp serve in every agent\'s project settings, keeping what is there', async (t) => {
  const { root, home, env } = await dirs(t);
  await mkdir(path.join(root, '.vscode'), { recursive: true });
  await writeFile(path.join(root, '.vscode', 'mcp.json'), '{\n  // my servers\n  "servers": { "other": { "command": "x" } },\n}\n');
  await mkdir(path.join(root, '.codex'), { recursive: true });
  await writeFile(path.join(root, '.codex', 'config.toml'), '# keep me\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n');
  const results = await shareMcp({ root, home, env, launch, targets: SHARE_TARGETS.filter((x) => x !== 'copilot') });
  assert.ok(results.every((r) => r.state === 'added'), JSON.stringify(results));
  const json = async (rel) => parseJsonc(await readFile(path.join(root, rel), 'utf8'));
  assert.deepEqual((await json('.mcp.json')).mcpServers.oasis, { command: 'oasis', args: ['mcp', 'serve'] });
  assert.deepEqual((await json('.cursor/mcp.json')).mcpServers.oasis, launch);
  const vscodeText = await readFile(path.join(root, '.vscode', 'mcp.json'), 'utf8');
  assert.match(vscodeText, /\/\/ my servers/);
  assert.deepEqual(parseJsonc(vscodeText).servers, { other: { command: 'x' }, oasis: { type: 'stdio', command: 'oasis', args: ['mcp', 'serve'] } });
  assert.deepEqual((await json('.gemini/settings.json')).mcpServers.oasis, launch);
  assert.deepEqual((await json('opencode.json')).mcp.oasis, { type: 'local', command: ['oasis', 'mcp', 'serve'], enabled: true });
  assert.deepEqual((await json('.zed/settings.json')).context_servers.oasis, launch);
  const tomlText = await readFile(path.join(root, '.codex', 'config.toml'), 'utf8');
  assert.match(tomlText, /^# keep me/);
  const toml = parseToml(tomlText);
  assert.equal(toml.model, 'gpt-5');
  assert.deepEqual({ ...toml.mcp_servers.oasis }, { command: 'oasis', args: ['mcp', 'serve'] });
  assert.equal(toml.mcp_servers.other.command, 'x');

  // Again: nothing changes. --remove takes only ours out.
  assert.ok((await shareMcp({ root, home, env, launch, targets: ['vscode', 'codex'] })).every((r) => r.state === 'present'));
  const removed = await shareMcp({ root, home, env, launch, targets: ['vscode', 'codex'], remove: true });
  assert.ok(removed.every((r) => r.state === 'removed'));
  assert.deepEqual(parseJsonc(await readFile(path.join(root, '.vscode', 'mcp.json'), 'utf8')).servers, { other: { command: 'x' } });
  const after = parseToml(await readFile(path.join(root, '.codex', 'config.toml'), 'utf8'));
  assert.equal(after.mcp_servers.oasis, undefined);
  assert.equal(after.mcp_servers.other.command, 'x');
  assert.match(formatShareReport(removed, { root }), /VS Code \/ Copilot\s+removed\s+\.vscode\/mcp\.json/);
});

test('share --user writes user-level files and skips agents without one; broken files fail alone', async (t) => {
  const { root, home, env } = await dirs(t);
  await mkdir(path.join(home, '.gemini'), { recursive: true });
  await writeFile(path.join(home, '.gemini', 'settings.json'), '{ not json');
  const results = await shareMcp({ root, home, env, launch, user: true, targets: ['claude', 'copilot', 'gemini', 'cursor'], dryRun: false });
  const by = Object.fromEntries(results.map((r) => [r.target, r]));
  assert.equal(by.claude.state, 'skipped');
  assert.match(by.claude.note, /claude mcp add --scope user oasis -- oasis mcp serve/);
  assert.equal(by.copilot.state, 'added');
  assert.deepEqual(JSON.parse(await readFile(path.join(home, '.copilot', 'mcp-config.json'), 'utf8')).mcpServers.oasis, { type: 'local', command: 'oasis', args: ['mcp', 'serve'], tools: ['*'] });
  assert.equal(by.gemini.state, 'failed');
  assert.equal(await readFile(path.join(home, '.gemini', 'settings.json'), 'utf8'), '{ not json');
  assert.equal(by.cursor.state, 'added');
  const dry = await shareMcp({ root, home, env, launch, targets: ['claude'], dryRun: true });
  assert.equal(dry[0].state, 'added');
  await assert.rejects(readFile(path.join(root, '.mcp.json')));
  await assert.rejects(shareMcp({ root, home, env, launch, targets: ['emacs'] }), /Unknown agent/);
});
