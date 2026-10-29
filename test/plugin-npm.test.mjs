import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { addMarketplace, installPlugin, loadEnabledPlugins, readInstalledPlugins, fetchNpmPluginSource, resolveNpmInvocation } from '../src/claude-plugins.mjs';

async function put(file, content) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); }
const hasNpm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], { shell: process.platform === 'win32' }).status === 0;

test('npm plugin sources are fetched with npm pack from the given registry', { skip: !hasNpm }, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-npm-plugin-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  // Build a real tarball for @acme/oasis-greeter.
  const pkgDir = path.join(base, 'pkg');
  await put(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@acme/oasis-greeter', version: '2.1.0', scripts: { prepack: 'node -e "require(\'fs\').writeFileSync(\'SCRIPT_RAN\',\'1\')"' } }));
  await put(path.join(pkgDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'greeter', description: 'From npm' }));
  await put(path.join(pkgDir, 'commands', 'greet.md'), '---\ndescription: Greet someone\n---\nSay hi to $ARGUMENTS\n');
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', base], { cwd: pkgDir, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const tarballFile = path.join(base, JSON.parse(packed.stdout)[0].filename);
  const tarball = await readFile(tarballFile);
  const integrity = 'sha512-' + createHash('sha512').update(tarball).digest('base64');
  const shasum = createHash('sha1').update(tarball).digest('hex');
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    const origin = 'http://127.0.0.1:' + server.address().port;
    if (req.url === '/@acme%2foasis-greeter' || req.url === '/@acme%2Foasis-greeter') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ name: '@acme/oasis-greeter', 'dist-tags': { latest: '2.1.0' }, versions: { '2.1.0': { name: '@acme/oasis-greeter', version: '2.1.0', dist: { tarball: origin + '/tarballs/greeter-2.1.0.tgz', integrity, shasum } } } }));
    } else if (req.url === '/tarballs/greeter-2.1.0.tgz') { res.setHeader('content-type', 'application/octet-stream'); res.end(tarball); }
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const registry = 'http://127.0.0.1:' + server.address().port + '/';

  const home = path.join(base, 'home');
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, '.config', 'oasis'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), OASIS_PLUGIN_DIRS: '', OASIS_PLUGINS: '', npm_config_cache: path.join(base, 'npm-cache'), npm_config_userconfig: path.join(base, 'npmrc') };
  const market = path.join(base, 'market');
  await put(path.join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'npm-market', owner: { name: 'T' }, plugins: [{ name: 'greeter', source: { source: 'npm', package: '@acme/oasis-greeter', version: '^2.0.0', registry } }] }));
  const root = path.join(base, 'project');
  await mkdir(root, { recursive: true });
  await addMarketplace(market, { env, cwd: root });
  const result = await installPlugin('greeter@npm-market', { env, root });
  assert.ok(hits.some((url) => url.startsWith('/tarballs/')), 'tarball came from the registry');
  assert.deepEqual((await readdir(result.installPath)).sort(), ['.claude-plugin', 'commands', 'package.json']);
  const record = (await readInstalledPlugins(env))['greeter@npm-market'];
  assert.equal(record.version, '2.1.0');
  assert.equal(record.npm.package, '@acme/oasis-greeter');
  assert.equal(record.npm.integrity, integrity);
  const plugins = await loadEnabledPlugins(root, { env });
  assert.ok(plugins.some((plugin) => plugin.id === 'greeter@npm-market'));
});

test('Windows npm plugin installs resolve npm-cli.js instead of invoking npm.cmd through a shell', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-npm-invocation-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const execPath = path.join(base, 'node.exe');
  const cli = path.join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await put(cli, '// fixture npm cli');
  const invocation = await resolveNpmInvocation({ platform: 'win32', execPath, env: { PATH: '' } });
  assert.deepEqual(invocation, { command: execPath, argsPrefix: [cli] });
  await assert.rejects(
    resolveNpmInvocation({ platform: 'win32', execPath: path.join(base, 'missing', 'node.exe'), env: { PATH: '' } }),
    /Could not locate npm-cli\.js/
  );
});

test('npm plugin sources reject bad names, versions and plain-http registries', async () => {
  const staging = await mkdtemp(path.join(os.tmpdir(), 'oasis-npm-bad-'));
  await assert.rejects(fetchNpmPluginSource({ package: '../evil' }, staging), /valid package name/);
  await assert.rejects(fetchNpmPluginSource({ package: 'ok', version: '1.0; rm -rf' }, staging), /invalid version/);
  await assert.rejects(fetchNpmPluginSource({ package: 'ok', registry: 'http://registry.example.com' }, staging), /https/);
  await rm(staging, { recursive: true, force: true });
});
