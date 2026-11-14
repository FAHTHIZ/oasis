import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseYamlSubset, parseJsonc, splitMemoryEntries, planImport, applyImport, describePlan, parseImportArgs } from '../src/importers.mjs';
import { listMemories } from '../src/auto-memory.mjs';

async function put(file, content) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); }
const isFile = (file) => stat(file).then((info) => info.isFile(), () => false);

test('YAML subset, JSONC and memory splitting', () => {
  const yaml = parseYamlSubset('model: x # comment\nmcp_servers:\n  github:\n    command: npx\n    args: ["-y", "@mcp/github"]\n    env:\n      TOKEN: "a#b"\n  remote:\n    url: https://m.example/mcp\n    headers: { Authorization: "Bearer ${T}" }\n  listy:\n    command: uvx\n    args:\n      - server\n      - --flag\n');
  assert.equal(yaml.model, 'x');
  assert.deepEqual(yaml.mcp_servers.github.args, ['-y', '@mcp/github']);
  assert.equal(yaml.mcp_servers.github.env.TOKEN, 'a#b');
  assert.equal(yaml.mcp_servers.remote.headers.Authorization, 'Bearer ${T}');
  assert.deepEqual(yaml.mcp_servers.listy.args, ['server', '--flag']);
  assert.deepEqual(parseJsonc('{ // c\n "a": [1, 2,], /* x */ "b": "http://x//y" ,}'), { a: [1, 2], b: 'http://x//y' });
  assert.deepEqual(splitMemoryEntries('# Memory\nUses pnpm not npm\n§\nDeploys from the release branch'), ['Uses pnpm not npm', 'Deploys from the release branch']);
  assert.deepEqual(parseImportArgs(['hermes', 'opencode', '--yes']).sources, ['hermes', 'opencode']);
  assert.throws(() => parseImportArgs(['nope']), /hermes\|opencode/);
});

test('imports Hermes, OpenCode, Antigravity, Windsurf, Cline and Claude Code memories without overwriting', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-import-more-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  const home = path.join(base, 'home');
  await mkdir(root, { recursive: true });
  // Hermes
  await put(path.join(home, '.hermes', 'config.yaml'), 'mcp_servers:\n  github:\n    command: npx\n    args: ["-y", "@mcp/github"]\n  off:\n    command: x\n    enabled: false\n');
  await put(path.join(home, '.hermes', 'memories', 'MEMORY.md'), 'User runs Arch Linux with fish shell\n§\nProject builds need Node 22');
  await put(path.join(home, '.hermes', 'memories', 'USER.md'), 'Prefers short answers without emojis');
  await put(path.join(home, '.hermes', 'SOUL.md'), 'You are calm and direct.');
  await put(path.join(home, '.hermes', 'skills', 'devops', 'deploy-fly', 'SKILL.md'), '---\nname: deploy-fly\ndescription: Deploy to Fly\n---\nsteps');
  await put(path.join(home, '.hermes', 'skills', 'devops', 'deploy-fly', 'scripts', 'go.sh'), 'echo go');
  // OpenCode
  await put(path.join(root, 'opencode.jsonc'), '{\n // project\n "mcp": { "pw": { "type": "local", "command": ["bunx", "@playwright/mcp"], "environment": { "K": "{env:K}" } }, "docs": { "type": "remote", "url": "https://docs.example/mcp" } },\n "command": { "test": { "template": "Run tests for $ARGUMENTS", "description": "tests" } },\n}');
  await put(path.join(root, '.opencode', 'agents', 'reviewer.md'), '---\ndescription: Reviews code\nmode: subagent\ntools:\n  write: false\n  read: true\n  grep: true\n---\nReview carefully.');
  // Antigravity
  await put(path.join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { linear: { serverUrl: 'https://mcp.linear.app/mcp' } } }));
  await put(path.join(home, '.gemini', 'config', 'skills', 'migrate-db', 'SKILL.md'), '---\nname: migrate-db\ndescription: migrations\n---\nbody');
  await put(path.join(root, '.agents', 'rules', 'ts.md'), '---\ntrigger: glob\nglobs: src/**/*.ts\ndescription: TS style\n---\nUse zod.');
  await put(path.join(root, '.agents', 'rules', 'manual.md'), '---\ntrigger: manual\n---\nOnly when asked.');
  await put(path.join(root, '.agents', 'workflows', 'release.md'), '---\ndescription: release\n---\n1. bump\n2. tag');
  // Windsurf and Cline
  await put(path.join(root, '.windsurfrules'), 'Prefer small PRs.');
  await put(path.join(root, '.windsurf', 'rules', 'always.md'), '---\ntrigger: always_on\n---\nWrite tests.');
  await put(path.join(root, '.clinerules', 'style.md'), 'Two-space indent.');
  await put(path.join(root, '.clinerules', 'workflows', 'pr.md'), 'Open a PR');
  // Claude Code project memory
  const slugDir = root.replace(/[^A-Za-z0-9]/g, '-');
  await put(path.join(home, '.claude', 'projects', slugDir, 'memory', 'MEMORY.md'), '- [testing](testing.md)');
  await put(path.join(home, '.claude', 'projects', slugDir, 'memory', 'testing.md'), '---\nname: Integration tests hit a real database\ndescription: no mocks\ntype: feedback\n---\nDo not mock the database in integration tests.');
  // Existing target is never overwritten.
  await put(path.join(root, '.claude', 'rules', 'windsurfrules.md'), 'mine');

  const env = { HOME: home };
  const plan = await planImport(root, { env, sources: ['hermes', 'opencode', 'antigravity', 'windsurf', 'cline', 'claude'] });
  const text = describePlan(plan);
  assert.match(text, /\[hermes\] MCP server github \(user\)/);
  assert.match(text, /\[hermes\] MCP server off .*disabled/);
  assert.match(text, /\[antigravity\] Rule manual .*manual rule/);
  assert.match(text, /\[windsurf\] Rule \.windsurfrules .*target exists/);
  await applyImport(plan);

  const configDir = path.join(home, '.config', 'oasis');
  const userMcp = JSON.parse(await readFile(path.join(configDir, 'mcp.json'), 'utf8')).mcpServers;
  assert.deepEqual(userMcp.github, { command: 'npx', args: ['-y', '@mcp/github'] });
  assert.deepEqual(userMcp.linear, { type: 'http', url: 'https://mcp.linear.app/mcp' });
  const projectMcp = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8')).mcpServers;
  assert.deepEqual(projectMcp.pw, { command: 'bunx', args: ['@playwright/mcp'], env: { K: '${K}' } });
  assert.deepEqual(projectMcp.docs, { type: 'http', url: 'https://docs.example/mcp' });

  assert.match(await readFile(path.join(root, '.oasis', 'commands', 'test.md'), 'utf8'), /Run tests for \$ARGUMENTS/);
  assert.match(await readFile(path.join(root, '.oasis', 'commands', 'release.md'), 'utf8'), /bump/);
  assert.ok(await isFile(path.join(root, '.oasis', 'commands', 'pr.md')));
  const agent = await readFile(path.join(root, '.claude', 'agents', 'reviewer.md'), 'utf8');
  assert.match(agent, /name: reviewer/);
  assert.match(agent, /tools: Read, Grep/);
  const tsRule = await readFile(path.join(root, '.claude', 'rules', 'antigravity-ts.md'), 'utf8');
  assert.match(tsRule, /paths:\n {2}- "src\/\*\*\/\*\.ts"/);
  assert.ok(!await isFile(path.join(root, '.claude', 'rules', 'antigravity-manual.md')));
  assert.equal(await readFile(path.join(root, '.claude', 'rules', 'windsurfrules.md'), 'utf8'), 'mine');
  assert.match(await readFile(path.join(root, '.claude', 'rules', 'windsurf-always.md'), 'utf8'), /Write tests/);
  assert.match(await readFile(path.join(root, '.claude', 'rules', 'cline-style.md'), 'utf8'), /Two-space/);

  const skills = path.join(home, '.config', 'agents', 'skills');
  assert.ok(await isFile(path.join(skills, 'deploy-fly', 'scripts', 'go.sh')));
  assert.ok(await isFile(path.join(skills, 'migrate-db', 'SKILL.md')));
  assert.match(await readFile(path.join(configDir, 'OASIS.md'), 'utf8'), /calm and direct/);

  const memEnv = { ...process.env, OASIS_CONFIG_DIR: configDir };
  const memories = await listMemories(root, { env: memEnv });
  const names = memories.map((m) => m.scope + ':' + m.name);
  assert.ok(names.some((n) => /^user:Hermes memory 1/.test(n)), names.join(','));
  assert.ok(names.some((n) => /^user:Hermes user profile 1/.test(n)));
  assert.ok(names.includes('project:Integration tests hit a real database'));

  // A second run finds nothing new.
  const again = await planImport(root, { env, sources: ['hermes', 'opencode', 'antigravity', 'windsurf', 'cline', 'claude'] });
  assert.equal(again.items.filter((item) => item.action !== 'skip').length, 0, describePlan(again));
});

// The lenient reader turned a broken mcp.json into {}, and the import then
// replaced it with only the imported servers.
test('import never replaces an mcp.json that does not parse', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-import-broken-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  const home = path.join(base, 'home');
  await mkdir(root, { recursive: true });
  await put(path.join(home, '.hermes', 'config.yaml'), 'mcp_servers:\n  github:\n    command: npx\n    args: ["-y", "@mcp/github"]\n');
  await put(path.join(home, '.hermes', 'SOUL.md'), 'You are calm.');
  const target = path.join(home, '.config', 'oasis', 'mcp.json');
  const broken = '{ "mcpServers": { "keep": { "command": "x" } }, }';
  await put(target, broken);
  const plan = await planImport(root, { env: { HOME: home }, sources: ['hermes'] });
  await assert.rejects(applyImport(plan), /Could not read .*mcp\.json/);
  assert.equal(await readFile(target, 'utf8'), broken);
});
