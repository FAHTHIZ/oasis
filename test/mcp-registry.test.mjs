import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { searchRegistry, entryFromRegistry, installFromRegistry, defaultLocalName, parseInstallArgs, formatSearchResults, registryBase } from '../src/mcp-registry.mjs';

const wrap = (server, extra = {}) => ({ server, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', updatedAt: '2026-10-21T00:00:00Z', ...extra } } });
const GITHUB = { name: 'io.github.github/github-mcp-server', title: 'GitHub', description: 'GitHub tools', version: '2.0.3', repository: { url: 'https://github.com/github/github-mcp-server' },
  packages: [{ registryType: 'oci', identifier: 'ghcr.io/github/github-mcp-server:2.0.3', transport: { type: 'stdio' }, runtimeArguments: [
    { type: 'named', name: '-e', value: 'GITHUB_PERSONAL_ACCESS_TOKEN={token}', variables: { token: { isSecret: true } } }] }],
  remotes: [{ type: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/', headers: [{ name: 'Authorization', isSecret: true }] }] };

function fakeFetch(routes, calls = []) {
  return async (url) => {
    calls.push(url);
    for (const [pattern, body] of routes) if (pattern.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify(typeof body === 'function' ? body(url) : body) };
    return { ok: false, status: 404, text: async () => '' };
  };
}

test('search asks for the vendor namespace first and ranks it above look-alikes', async () => {
  const calls = [];
  const fetchImpl = fakeFetch([
    [/search=github%2F/, { servers: [wrap(GITHUB)], metadata: {} }],
    [/search=github(&|$)/, { servers: [wrap({ name: 'com.aaa/github', description: 'clone', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://x' }] }), wrap(GITHUB), wrap({ name: 'com.zzz/old-github', version: '1' }, { status: 'deprecated' })], metadata: {} }]
  ], calls);
  const rows = await searchRegistry('github', { env: {}, fetchImpl });
  assert.match(calls[0], /search=github%2F/);
  assert.deepEqual(rows.map((row) => row.name), ['io.github.github/github-mcp-server', 'com.aaa/github'], 'deduplicated, deprecated dropped');
  assert.deepEqual(rows[0].kinds, ['oci', 'remote']);
  assert.match(formatSearchResults(rows, 'github'), /oasis mcp install NAME/);
  await assert.rejects(() => searchRegistry('', { env: {}, fetchImpl }), /Usage/);
});

test('registry URL override must be https (loopback allowed for testing)', () => {
  assert.equal(registryBase({}), 'https://registry.modelcontextprotocol.io');
  assert.throws(() => registryBase({ OASIS_MCP_REGISTRY_URL: 'http://evil.example' }), /https/);
  assert.equal(registryBase({ OASIS_MCP_REGISTRY_URL: 'http://127.0.0.1:9/' }), 'http://127.0.0.1:9');
});

test('local names drop mcp suffixes and fall back to the publisher', () => {
  assert.equal(defaultLocalName('io.github.github/github-mcp-server'), 'github');
  assert.equal(defaultLocalName('com.notion/mcp'), 'notion');
  assert.equal(defaultLocalName('io.github.microsoft/playwright-mcp'), 'playwright');
  assert.equal(defaultLocalName('com.x/mcp-server-postgres'), 'postgres');
});

test('entries pin versions and never contain secrets', () => {
  const npm = entryFromRegistry({ name: 'io.github.microsoft/playwright-mcp', version: '0.0.84', packages: [{ registryType: 'npm', identifier: '@playwright/mcp', version: '0.0.84', transport: { type: 'stdio' } }] }, { prefer: 'npm' });
  assert.deepEqual(npm.entry, { command: 'npx', args: ['-y', '@playwright/mcp@0.0.84'] });

  const pypi = entryFromRegistry({ name: 'io.github.x/fetch', version: '1.2.0', packages: [{ registryType: 'pypi', identifier: 'mcp-server-fetch', transport: { type: 'stdio' },
    environmentVariables: [{ name: 'FETCH_API_KEY', isRequired: true, isSecret: true }, { name: 'FETCH_LOG', description: 'log level' }] }] }, { prefer: 'pypi' });
  assert.deepEqual(pypi.entry, { command: 'uvx', args: ['mcp-server-fetch==1.2.0'], env: { FETCH_API_KEY: '${FETCH_API_KEY}' } });
  assert.deepEqual(pypi.requiredEnv, ['FETCH_API_KEY']);
  assert.match(pypi.optionalEnv[0], /FETCH_LOG/);

  const oci = entryFromRegistry(GITHUB, { prefer: 'oci', localName: 'github' });
  assert.deepEqual(oci.entry.args, ['run', '-i', '--rm', 'ghcr.io/github/github-mcp-server:2.0.3'], 'optional secret argument is left out');

  const remote = entryFromRegistry(GITHUB, { prefer: 'remote', localName: 'github' });
  assert.deepEqual(remote.entry, { type: 'http', url: 'https://api.githubcopilot.com/mcp/' }, 'optional auth header is left for oasis mcp login');

  const keyed = entryFromRegistry({ name: 'com.acme/mcp', remotes: [{ type: 'sse', url: 'https://{region}.acme.dev/sse', variables: { region: { default: 'eu' } }, headers: [{ name: 'Authorization', isRequired: true, isSecret: true }, { name: 'X-Team', isRequired: true, value: '{team}' }] }] }, { localName: 'acme' });
  assert.deepEqual(keyed.entry, { type: 'sse', url: 'https://eu.acme.dev/sse', headers: { Authorization: 'Bearer ${ACME_TOKEN}', 'X-Team': '${ACME_TEAM}' } });
  assert.deepEqual(keyed.requiredEnv.sort(), ['ACME_TEAM', 'ACME_TOKEN']);
});

test('auto picks an open remote, else a package whose runtime is installed', () => {
  const both = { name: 'io.github.x/thing', version: '1.0.0', packages: [{ registryType: 'npm', identifier: 'thing', transport: { type: 'stdio' } }], remotes: [{ type: 'streamable-http', url: 'https://thing.dev/mcp' }] };
  assert.equal(entryFromRegistry(both, { env: { PATH: '' } }).kind, 'remote');
  const lockedRemote = { ...both, remotes: [{ type: 'streamable-http', url: 'https://thing.dev/mcp', headers: [{ name: 'X-Api-Key', isRequired: true }] }] };
  assert.equal(entryFromRegistry(lockedRemote, { env: { PATH: process.env.PATH } }).kind, 'npm', 'npx is on PATH in tests');
  assert.throws(() => entryFromRegistry({ name: 'a/b', packages: [{ registryType: 'nuget', identifier: 'B' }] }), /nothing OASIS can run|none|nuget/);
});

test('required positional arguments must be passed after --', () => {
  const fs = { name: 'io.github.x/filesystem', version: '1.0.0', packages: [{ registryType: 'npm', identifier: '@x/fs', transport: { type: 'stdio' }, packageArguments: [{ type: 'positional', valueHint: 'allowed_directory', isRequired: true }] }] };
  assert.match(entryFromRegistry(fs, { prefer: 'npm' }).problems[0], /allowed_directory.*after --/);
  const ok = entryFromRegistry(fs, { prefer: 'npm', extraArgs: ['/home/me/code'] });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.entry.args, ['-y', '@x/fs@1.0.0', '/home/me/code']);
  assert.deepEqual(parseInstallArgs(['io.github.x/filesystem', '--scope', 'project', '--', '/a', '/b']), { scope: 'project', prefer: 'auto', extraArgs: ['/a', '/b'], registryName: 'io.github.x/filesystem' });
  assert.throws(() => parseInstallArgs(['a/b', '--package', 'gem']), /npm, pypi or oci/);
});

test('install asks first, writes a private user mcp.json, and project scope keeps secrets as ${VAR}', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-registry-'));
  try {
    const env = { OASIS_CONFIG_DIR: path.join(dir, 'config'), PATH: '' };
    const fetchImpl = fakeFetch([[/servers\/io\.github\.github%2Fgithub-mcp-server\/versions\/latest/, { server: GITHUB }]]);
    const prompts = [];
    const cancelled = await installFromRegistry(['io.github.github/github-mcp-server'], { root: dir, env, fetchImpl, approve: async (text) => { prompts.push(text); return false; } });
    assert.match(cancelled, /cancelled/);
    await assert.rejects(() => stat(path.join(dir, 'config', 'mcp.json')), /ENOENT/);
    assert.match(prompts[0], /Source: https:\/\/github\.com\/github\/github-mcp-server/);

    const added = await installFromRegistry(['io.github.github/github-mcp-server'], { root: dir, env, fetchImpl, approve: async () => true });
    assert.match(added, /Added MCP server "github" \(remote\)/);
    assert.match(added, /oasis mcp login github/);
    const file = path.join(dir, 'config', 'mcp.json');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).mcpServers.github, { type: 'http', url: 'https://api.githubcopilot.com/mcp/' });
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);

    const keyedFetch = fakeFetch([[/versions\/latest/, { server: { name: 'com.acme/mcp', version: '3.1.0', packages: [{ registryType: 'npm', identifier: '@acme/mcp', transport: { type: 'stdio' }, environmentVariables: [{ name: 'ACME_KEY', isRequired: true, isSecret: true }] }] } }]]);
    const project = await installFromRegistry(['com.acme/mcp', '--scope', 'project', '--name', 'acme'], { root: dir, env, fetchImpl: keyedFetch, approve: async () => true });
    assert.match(project, /Set ACME_KEY before starting OASIS/);
    assert.match(project, /oasis trust/);
    const written = JSON.parse(await readFile(path.join(dir, '.mcp.json'), 'utf8'));
    assert.deepEqual(written.mcpServers.acme, { command: 'npx', args: ['-y', '@acme/mcp@3.1.0'], env: { ACME_KEY: '${ACME_KEY}' } });

    await assert.rejects(() => installFromRegistry(['not a name'], { root: dir, env, fetchImpl, approve: async () => true }), /io\.github\.owner\/server/);
    await assert.rejects(() => installFromRegistry(['io.github.nobody/none'], { root: dir, env, fetchImpl, approve: async () => true }), /No MCP Registry server/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
