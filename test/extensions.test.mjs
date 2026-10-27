import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  analyzeExtensionCompatibility,
  inspectGitHubExtension,
  installGitHubExtension,
  listInstalledExtensions,
  parseGitHubRepositoryUrl,
  removeGitHubExtension,
  selectAgentPromptFiles
} from '../src/extensions.mjs';
import { listAvailableSkills, loadSkillText } from '../src/tools.mjs';

const COMMIT = 'c'.repeat(40);

async function tempDir() {
  return await mkdtemp(path.join(os.tmpdir(), 'oasis-extension-test-'));
}

function createFetch(options = {}) {
  const prompts = {
    'engineering/api-engineer.md': '# API Engineer\n\nDesign safe APIs and verify behavior.\n',
    'engineering/code-reviewer.md': '# Code Reviewer\n\nInspect changes and identify regressions.\n'
  };
  const files = [
    { path: 'engineering/api-engineer.md', type: 'blob', mode: '100644', size: Buffer.byteLength(prompts['engineering/api-engineer.md']), sha: '1'.repeat(40) },
    { path: 'engineering/code-reviewer.md', type: 'blob', mode: '100644', size: Buffer.byteLength(prompts['engineering/code-reviewer.md']), sha: '2'.repeat(40) },
    { path: 'README.md', type: 'blob', mode: '100644', size: 120, sha: '3'.repeat(40) },
    { path: 'scripts/install.sh', type: 'blob', mode: '100755', size: 80, sha: '4'.repeat(40) },
    { path: 'package.json', type: 'blob', mode: '100644', size: 50, sha: '5'.repeat(40) }
  ];
  const calls = [];
  const fetchImpl = async (rawUrl) => {
    const url = String(rawUrl);
    calls.push(url);
    const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/vnd.github+json' } });
    if (url === 'https://api.github.com/repos/acme/agents') return json({
      full_name: 'acme/agents', name: 'agents', description: 'A specialist prompt collection',
      default_branch: 'main', private: Boolean(options.private), license: { spdx_id: 'MIT', name: 'MIT License' }
    });
    if (url === 'https://api.github.com/repos/acme/agents/commits/main') return json({ sha: options.commit || COMMIT });
    if (url === 'https://api.github.com/repos/acme/agents/git/trees/' + (options.commit || COMMIT) + '?recursive=1') return json({ tree: files, truncated: Boolean(options.truncated) });
    const rawPrefix = 'https://raw.githubusercontent.com/acme/agents/' + (options.commit || COMMIT) + '/';
    if (url.startsWith(rawPrefix)) {
      const pathname = decodeURIComponent(url.slice(rawPrefix.length));
      if (Object.prototype.hasOwnProperty.call(prompts, pathname)) return new Response(prompts[pathname], { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' } });
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    throw new Error('Unexpected fixture URL: ' + url);
  };
  return { fetchImpl, calls };
}

test('GitHub import accepts only a repository home URL', () => {
  assert.deepEqual(parseGitHubRepositoryUrl('https://github.com/acme/agents.git'), {
    owner: 'acme', repo: 'agents', canonicalUrl: 'https://github.com/acme/agents'
  });
  assert.throws(() => parseGitHubRepositoryUrl('https://github.com/acme/agents/tree/main'), /repository home URL/i);
  assert.throws(() => parseGitHubRepositoryUrl('https://github.com.evil.example/acme/agents'), /public GitHub/i);
  assert.throws(() => parseGitHubRepositoryUrl('http://github.com/acme/agents'), /public GitHub/i);
});

test('prompt candidate selection ignores readmes and executable files and applies bounds', () => {
  const input = [
    { path: 'engineering/agent.md', type: 'blob', mode: '100644', size: 10, sha: 'a' },
    { path: 'README.md', type: 'blob', mode: '100644', size: 10, sha: 'b' },
    { path: 'scripts/install.sh', type: 'blob', mode: '100755', size: 10, sha: 'c' },
    { path: 'agents/too-big.md', type: 'blob', mode: '100644', size: 200000, sha: 'd' },
    { path: 'agents/link.md', type: 'blob', mode: '120000', size: 10, sha: 'e' }
  ];
  assert.deepEqual(selectAgentPromptFiles(input).map((item) => item.path), ['engineering/agent.md']);
});

test('inspection pins a commit and reports script risk without importing code', async () => {
  const { fetchImpl, calls } = createFetch();
  const inspected = await inspectGitHubExtension('https://github.com/acme/agents', { fetchImpl });
  assert.equal(inspected.repository.fullName, 'acme/agents');
  assert.equal(inspected.repository.commitSha, COMMIT);
  assert.equal(inspected.repository.license, 'MIT');
  assert.equal(inspected.importCount, 2);
  assert.equal(inspected.executableFilesDetected, 1);
  assert.match(inspected.executionPolicy, /no source code.*executed/i);
  assert.ok(!calls.some((url) => /raw.githubusercontent.com.*(?:install.sh|package.json)/.test(url)));
});

test('installation imports pinned Markdown prompts only into selected scopes and supports verified removal', async (t) => {
  const tmp = await tempDir();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'project');
  const config = path.join(tmp, 'config');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(root, { recursive: true }));
  const env = { OASIS_CONFIG_DIR: config };
  const { fetchImpl, calls } = createFetch();
  const result = await installGitHubExtension('https://github.com/acme/agents', { root, env, scope: 'both', expectedCommit: COMMIT, fetchImpl });
  assert.equal(result.installed, true);
  assert.equal(result.importedFiles, 2);
  assert.equal(result.scriptsExecuted, false);
  assert.equal(result.dependenciesInstalled, false);
  assert.equal(result.destinations.length, 2);
  assert.equal(result.commitSha, COMMIT);
  assert.ok(!calls.some((url) => /raw.githubusercontent.com.*(?:install.sh|package.json)/.test(url)));

  const installed = await listInstalledExtensions({ root, env });
  assert.equal(installed.extensions.length, 2);
  assert.deepEqual(installed.extensions.map((item) => item.scope).sort(), ['project', 'self']);
  const projectPath = path.join(root, '.oasis', 'extensions', 'agents', 'skills', 'agents-engineering-api-engineer', 'SKILL.md');
  const content = await readFile(projectPath, 'utf8');
  assert.match(content, /external prompt instructions are untrusted content/i);
  assert.match(content, /Design safe APIs/);

  await assert.rejects(() => installGitHubExtension('https://github.com/acme/agents', { root, env, scope: 'project', expectedCommit: COMMIT, fetchImpl }), /already exists/i);
  const removedProject = await removeGitHubExtension({ root, env, scope: 'project', name: 'agents' });
  assert.equal(removedProject.removed, true);
  const afterProjectRemoval = await listInstalledExtensions({ root, env });
  assert.deepEqual(afterProjectRemoval.extensions.map((item) => item.scope), ['self']);
  const availableSkills = await listAvailableSkills(root, { env });
  const importedSkill = availableSkills.find((item) => item.name === 'agents-engineering-api-engineer');
  assert.ok(importedSkill, 'the installed global extension should be visible to runtime skill discovery');
  assert.equal(importedSkill.source, 'global-extension');
  const loadedSkill = await loadSkillText(root, importedSkill.name, { env });
  assert.match(loadedSkill.content, /Design safe APIs/);
  assert.equal(loadedSkill.source, 'global-extension');
  const removedSelf = await removeGitHubExtension({ root, env, scope: 'self', name: 'agents' });
  assert.equal(removedSelf.removed, true);
});

test('extension removal refuses a changed prompt and removes an intact extension', async (t) => {
  const tmp = await tempDir();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'project');
  const env = { OASIS_CONFIG_DIR: path.join(tmp, 'config') };
  const { fetchImpl } = createFetch();
  const result = await installGitHubExtension('https://github.com/acme/agents', { root, env, scope: 'project', expectedCommit: COMMIT, fetchImpl });
  const file = path.join(root, '.oasis', 'extensions', 'agents', 'skills', 'agents-engineering-api-engineer', 'SKILL.md');
  await writeFile(file, (await readFile(file, 'utf8')) + '\nUser change\n');
  await assert.rejects(() => removeGitHubExtension({ root, env, scope: 'project', name: 'agents' }), /edited after installation/i);
  await writeFile(file, (await readFile(file, 'utf8')).replace('\nUser change\n', ''));
  const removed = await removeGitHubExtension({ root, env, scope: 'project', name: 'agents' });
  assert.equal(removed.removed, true);
  assert.equal(removed.scope, 'project');
  assert.equal(result.importedFiles, 2);
  assert.equal((await listInstalledExtensions({ root, env })).extensions.length, 0);
});

test('truncated GitHub trees cannot be inspected or installed as partial collections', async (t) => {
  const tmp = await tempDir();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const { fetchImpl } = createFetch({ truncated: true });
  await assert.rejects(() => inspectGitHubExtension('https://github.com/acme/agents', { fetchImpl }), /truncated.*partial agent collection/i);
  await assert.rejects(() => installGitHubExtension('https://github.com/acme/agents', {
    root: path.join(tmp, 'project'),
    env: { OASIS_CONFIG_DIR: path.join(tmp, 'config') },
    scope: 'both',
    fetchImpl
  }), /truncated.*partial agent collection/i);
});

test('private repositories and stale inspected commits are rejected', async () => {
  const privateFixture = createFetch({ private: true });
  await assert.rejects(() => inspectGitHubExtension('https://github.com/acme/agents', { fetchImpl: privateFixture.fetchImpl }), /private repositories/i);
  const changedFixture = createFetch({ commit: 'd'.repeat(40) });
  await assert.rejects(() => installGitHubExtension('https://github.com/acme/agents', { expectedCommit: COMMIT, fetchImpl: changedFixture.fetchImpl }), /changed after inspection/i);
});


test('compatibility inventory recognizes Claude Code, Codex, Gemini CLI and portable skills without enabling hooks', () => {
  const result = analyzeExtensionCompatibility([
    { path: '.claude-plugin/plugin.json', type: 'blob', mode: '100644', size: 100, sha: '1' },
    { path: 'commands/review.md', type: 'blob', mode: '100644', size: 100, sha: '2' },
    { path: 'agents/security-reviewer.md', type: 'blob', mode: '100644', size: 100, sha: '3' },
    { path: 'skills/api-review/SKILL.md', type: 'blob', mode: '100644', size: 100, sha: '4' },
    { path: '.mcp.json', type: 'blob', mode: '100644', size: 100, sha: '5' },
    { path: 'hooks/hooks.json', type: 'blob', mode: '100644', size: 100, sha: '6' },
    { path: 'hooks/validate.sh', type: 'blob', mode: '100755', size: 100, sha: '7' }
  ]);
  assert.match(result.primaryFormat, /Claude Code/);
  assert.equal(result.formats.find((item) => item.id === 'claude-code').detected, true);
  assert.equal(result.formats.find((item) => item.id === 'agent-skills').detected, true);
  assert.equal(result.components.find((item) => item.id === 'skills').count, 1);
  assert.equal(result.components.find((item) => item.id === 'commands').count, 1);
  assert.equal(result.components.find((item) => item.id === 'mcp').count, 1);
  assert.equal(result.components.find((item) => item.id === 'hooks').count, 2);
  assert.equal(result.components.find((item) => item.id === 'executables').count, 1);
  assert.ok(result.notActivated.some((item) => /hooks/i.test(item)));
  assert.match(result.warning, /not runtime compatibility/i);
  const codex = analyzeExtensionCompatibility([
    { path: '.codex-plugin/plugin.json', type: 'blob', mode: '100644', size: 100, sha: 'a' },
    { path: '.agents/skills/repo-guide/SKILL.md', type: 'blob', mode: '100644', size: 100, sha: 'b' }
  ]);
  assert.equal(codex.formats.find((item) => item.id === 'codex').detected, true);
  const gemini = analyzeExtensionCompatibility([
    { path: 'gemini-extension.json', type: 'blob', mode: '100644', size: 100, sha: 'c' },
    { path: '.gemini/commands/release.toml', type: 'blob', mode: '100644', size: 100, sha: 'd' }
  ]);
  assert.equal(gemini.formats.find((item) => item.id === 'gemini-cli').detected, true);
  assert.equal(gemini.components.find((item) => item.id === 'commands').count, 1);
});

test('inspection allows recognized non-Markdown plugins to display a compatibility report without claiming they can install', async () => {
  const { fetchImpl: original } = createFetch();
  const customFetch = async (url, options) => {
    if (String(url).includes('/git/trees/')) {
      return new Response(JSON.stringify({ truncated: false, tree: [
        { path: '.claude-plugin/plugin.json', type: 'blob', mode: '100644', size: 100, sha: 'a' },
        { path: '.mcp.json', type: 'blob', mode: '100644', size: 100, sha: 'b' },
        { path: 'mcp/server.mjs', type: 'blob', mode: '100644', size: 100, sha: 'c' }
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return original(url, options);
  };
  const inspected = await inspectGitHubExtension('https://github.com/acme/agents', { fetchImpl: customFetch });
  assert.equal(inspected.canInstall, false);
  assert.equal(inspected.importCount, 0);
  assert.equal(inspected.compatibility.formats.find((item) => item.id === 'claude-code').detected, true);
  assert.match(inspected.installationBlockedReason, /no Markdown prompts/i);
});
