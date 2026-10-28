import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DEFAULT_AUTO_MODE, effectiveAutoModeConfig, critiqueAutoMode, classifyAction, newAutoModeState, ruleLabel, parseClassifierReply } from '../src/auto-mode.mjs';
import { loadSettings, setWorkspaceTrust } from '../src/settings.mjs';
import { readZipEntries, extractZip, fetchPluginArchive } from '../src/zip.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

test('autoMode sections replace defaults unless they include $defaults', () => {
  const config = effectiveAutoModeConfig({ allow: ['$defaults', 'Deploy staging: pushing to the staging environment is fine.'], soft_deny: ['Only this one rule applies here.'] });
  assert.equal(config.allow.length, DEFAULT_AUTO_MODE.allow.length + 1);
  assert.deepEqual(config.soft_deny, ['Only this one rule applies here.']);
  assert.deepEqual(config.hard_deny, [...DEFAULT_AUTO_MODE.hard_deny]);
  const project = effectiveAutoModeConfig({ project: { hard_deny: ['Never touch prod: do not touch infra/prod.'] } });
  assert.equal(project.hard_deny.length, DEFAULT_AUTO_MODE.hard_deny.length + 1);
  assert.equal(ruleLabel('Force push history: git push --force'), 'Force push history');
  assert.deepEqual(parseClassifierReply('{"decision":"block","rule":"Secrets access","reason":"reads .env"}'), { decision: 'block', reason: 'reads .env', rule: 'Secrets access' });
});

test('critique flags dropped defaults, short rules, regexes and broad allows', () => {
  const notes = critiqueAutoMode({ hard_deny: ['x'], allow: ['$defaults', 'Allow anything the user wants to run.', '^rm .*$'] }).join('\n');
  assert.match(notes, /hard_deny replaces all/);
  assert.match(notes, /very short/);
  assert.match(notes, /very broad/);
  assert.match(notes, /regex/);
  assert.match(critiqueAutoMode(null)[0], /No custom autoMode rules/);
});

test('the classifier system prompt carries the effective sections', async () => {
  let system = '';
  const verdict = await classifyAction(newAutoModeState(), { toolName: 'Bash', args: { command: 'ls' }, messages: [], root: '/x' }, async (request) => { system = request.system; return '{"decision":"allow","reason":"ok"}'; }, { config: { environment: ['Trusted bucket: s3://acme-builds is ours.'] } });
  assert.equal(verdict.decision, 'allow');
  assert.match(system, /s3:\/\/acme-builds/);
  assert.match(system, /HARD DENY/);
  assert.match(system, /Force push history/);
});

test('project settings may add deny rules but cannot replace or loosen autoMode', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-am-home-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-am-root-'));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_IGNORE_CLAUDE_SETTINGS: '1' };
  await mkdir(path.join(home, 'cfg'), { recursive: true });
  await writeFile(path.join(home, 'cfg', 'settings.json'), JSON.stringify({ autoMode: { environment: ['$defaults', 'Trusted bucket: s3://acme'], classifyAllShell: true } }));
  await mkdir(path.join(root, '.oasis'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'settings.json'), JSON.stringify({ autoMode: { allow: ['Allow everything.'], hard_deny: ['No prod: never touch prod.'] } }));
  await setWorkspaceTrust(root, true, env);
  const settings = await loadSettings(root, { env });
  assert.ok(settings.autoMode.environment.includes('Trusted bucket: s3://acme'));
  assert.equal(settings.autoMode.allow, undefined);
  assert.deepEqual(settings.autoMode.project.hard_deny, ['No prod: never touch prod.']);
  assert.equal(settings.autoMode.classifyAllShell, true);
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd: root, timeout: 20000 });
  const config = JSON.parse(run(['auto-mode', 'config']).stdout);
  assert.ok(config.hard_deny.includes('No prod: never touch prod.'));
  assert.equal(config.allow.length, DEFAULT_AUTO_MODE.allow.length);
  const labelled = JSON.parse(run(['auto-mode', 'defaults', '--label', 'secrets']).stdout);
  assert.equal(labelled.soft_deny.length, 1);
  assert.equal(labelled.allow.length, 0);
  assert.match(run(['auto-mode', 'reset', '--yes']).stdout, /reset to defaults/);
  assert.equal(JSON.parse(await readFile(path.join(home, 'cfg', 'settings.json'), 'utf8')).autoMode, undefined);
});

function makeZip(files) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text); const packed = deflateRawSync(data); const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed); centrals.push(central, nameBuf); offset += 30 + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('zip reader extracts deflated entries and rejects path escapes', async () => {
  const zip = makeZip({ 'a/b.txt': 'hello zip' });
  assert.equal(readZipEntries(zip)[0].content.toString(), 'hello zip');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-zip-'));
  await extractZip(zip, dir);
  assert.equal(await readFile(path.join(dir, 'a', 'b.txt'), 'utf8'), 'hello zip');
  await assert.rejects(extractZip(makeZip({ '../evil.txt': 'x' }), dir), /escapes/);
  assert.throws(() => readZipEntries(Buffer.from('nope')), /Not a zip/);
});

test('--plugin-url downloads a plugin zip and loads its commands for the session', async (t) => {
  const zip = makeZip({ 'myplug/.claude-plugin/plugin.json': JSON.stringify({ name: 'myplug', version: '1.0.0' }), 'myplug/commands/hello-url.md': '---\ndescription: hi from url\n---\nSay hi' });
  const server = createServer((req, res) => { if (req.url === '/p.zip') { res.setHeader('content-type', 'application/zip'); res.end(zip); } else { res.statusCode = 404; res.end(); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  const dir = await fetchPluginArchive(url + '/p.zip');
  assert.match(await readFile(path.join(dir, 'commands', 'hello-url.md'), 'utf8'), /Say hi/);
  await assert.rejects(fetchPluginArchive(url + '/missing.zip'), /HTTP 404/);
  await assert.rejects(fetchPluginArchive('ftp://x/y.zip'), /http/);
});
