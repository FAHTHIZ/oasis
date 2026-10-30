import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseToml, planImport, applyImport, describePlan } from '../src/importers.mjs';
import { loadUserMcpJson } from '../src/mcp-project.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';

test('parseToml handles Codex-style config', () => {
  const data = parseToml('model = "gpt-5"\n# c\n[mcp_servers.docs]\ncommand = "npx"\nargs = ["-y", "@x/docs"]\nenv = { TOKEN = "t" }\n\n[mcp_servers.remote]\nurl = \'https://mcp.example.com/mcp\'\nbearer_token_env_var = "REMOTE_TOKEN"\nprompt = """\nline1\nline2"""\n');
  assert.equal(data.model, 'gpt-5');
  assert.deepEqual(data.mcp_servers.docs.args, ['-y', '@x/docs']);
  assert.equal(data.mcp_servers.docs.env.TOKEN, 't');
  assert.equal(data.mcp_servers.remote.prompt, 'line1\nline2');
});

test('parseToml rejects incomplete values and arrays without hanging', () => {
  for (const malformed of [
    'items = [',
    'items = [1',
    'items = [1,',
    'items = [1,,2]',
    'items = [{ key = 1 }',
    'items = [1, { key = }]',
    'name = "unterminated'
  ]) {
    assert.throws(() => parseToml(malformed), /TOML:/, malformed);
  }
});

test('imports Codex, Gemini CLI and Cursor configuration without overwriting', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-import-home-'));
  const root = path.join(home, 'proj');
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  await mkdir(path.join(home, '.codex', 'prompts'), { recursive: true });
  await writeFile(path.join(home, '.codex', 'config.toml'), '[mcp_servers.docs]\ncommand = "npx"\nargs = ["-y", "docs-mcp"]\n[mcp_servers.remote]\nurl = "https://mcp.example.com/mcp"\nbearer_token_env_var = "REMOTE_TOKEN"\n');
  await writeFile(path.join(home, '.codex', 'AGENTS.md'), 'Codex user rule');
  await writeFile(path.join(home, '.codex', 'prompts', 'fixit.md'), 'Fix $ARGUMENTS');
  await mkdir(path.join(home, '.gemini', 'commands', 'git'), { recursive: true });
  await writeFile(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { gh: { httpUrl: 'https://gh.example.com/mcp', headers: { A: 'b' } } } }));
  await writeFile(path.join(home, '.gemini', 'commands', 'git', 'commit.toml'), 'description = "Commit"\nprompt = """Write a commit for {{args}} using !{git diff --staged}"""\n');
  await mkdir(path.join(root, '.cursor', 'rules'), { recursive: true });
  await writeFile(path.join(root, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { db: { command: 'node', args: ['db.js'], env: { X: '1' } } } }));
  await writeFile(path.join(root, '.cursor', 'rules', 'ts.mdc'), '---\ndescription: TS rules\nglobs: src/**/*.ts, test/**/*.ts\nalwaysApply: false\n---\nUse strict types.\n');
  await writeFile(path.join(root, '.cursorrules'), 'Legacy cursor rule');
  await writeFile(path.join(root, 'GEMINI.md'), 'Project gemini rule');

  const plan = await planImport(root, { env });
  assert.match(describePlan(plan), /Will import/);
  const done = await applyImport(plan);
  assert.ok(done.length >= 9, describePlan(plan));
  const configDir = path.join(home, '.config', 'oasis');
  const userMcp = JSON.parse(await readFile(path.join(configDir, 'mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(userMcp.mcpServers).sort(), ['docs', 'gh', 'remote']);
  assert.equal(userMcp.mcpServers.remote.headers.Authorization, 'Bearer ${REMOTE_TOKEN}');
  assert.equal(userMcp.mcpServers.gh.type, 'http');
  const projectMcp = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8'));
  assert.equal(projectMcp.mcpServers.db.env.X, '1');
  assert.match(await readFile(path.join(configDir, 'OASIS.md'), 'utf8'), /Codex user rule/);
  assert.match(await readFile(path.join(configDir, 'commands', 'fixit.md'), 'utf8'), /Fix \$ARGUMENTS/);
  const commit = await readFile(path.join(configDir, 'commands', 'git', 'commit.md'), 'utf8');
  assert.match(commit, /for \$ARGUMENTS using !`git diff --staged`/);
  assert.match(commit, /description: "Commit"/);
  const rule = await readFile(path.join(root, '.claude', 'rules', 'cursor-ts.md'), 'utf8');
  assert.match(rule, /paths:\n  - "src\/\*\*\/\*.ts"\n  - "test\/\*\*\/\*.ts"/);
  assert.match(await readFile(path.join(root, '.claude', 'rules', 'gemini.md'), 'utf8'), /Project gemini rule/);
  assert.match(await readFile(path.join(root, '.claude', 'rules', 'cursorrules.md'), 'utf8'), /Legacy cursor rule/);

  const loaded = await loadUserMcpJson({ env: { ...env, REMOTE_TOKEN: 'sek' } });
  assert.equal(loaded.servers.find((s) => s.name === 'remote').headers.Authorization, 'Bearer sek');

  const again = await planImport(root, { env });
  assert.equal(again.items.filter((item) => item.action !== 'skip').length, 0);
  const dry = await runBuiltinCommand('import', 'cursor --dry-run', { root, env });
  assert.match(dry.output, /Nothing new to import/);
});
