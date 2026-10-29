import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { extractZip, fetchPluginArchive, readZipEntries } from '../src/zip.mjs';

function makeStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  let centralSize = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name, 'utf8');
    const body = Buffer.from(item.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14); // CRC is not currently inspected by this minimal reader.
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 * 65536) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    centralSize += central.length + name.length;
    localOffset += local.length + name.length + body.length;
  }
  const centralOffset = localOffset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const minimalPluginZip = () => makeStoredZip([{ name: '.claude-plugin/plugin.json', content: '{"name":"fixture"}' }]);

test('ZIP reader rejects traversal, absolute, drive, NUL, and ambiguous backslash paths', () => {
  for (const name of ['../escape.txt', '/absolute.txt', 'C:/outside.txt', 'nested/../../escape', 'folder\\..\\escape.txt']) {
    assert.throws(() => readZipEntries(makeStoredZip([{ name, content: 'nope' }])), /unsafe or ambiguous path/, name);
  }
  assert.throws(() => readZipEntries(makeStoredZip([{ name: 'nul\\0name.txt', content: 'nope' }])), /unsafe or ambiguous path/);
});

test('plugin archive downloads reject file URLs, public HTTP, and metadata/private IPs before fetching', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('network request must not occur'); };
  await assert.rejects(fetchPluginArchive('file:///etc/passwd', { fetchImpl }), /HTTP\(S\) URLs only/);
  await assert.rejects(fetchPluginArchive('http://archive.example.test/plugin.zip', { fetchImpl, lookupImpl: publicLookup }), /requires HTTPS/);
  await assert.rejects(fetchPluginArchive('https://169.254.169.254/latest/meta-data', { fetchImpl }), /private or special-purpose/);
  assert.equal(calls, 0);
});

test('plugin archive redirects are revalidated and public-to-loopback redirects are denied', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/private.zip' } });
  };
  await assert.rejects(
    fetchPluginArchive('https://archive.example.test/plugin.zip', { fetchImpl, lookupImpl: publicLookup }),
    /redirects from a public URL to loopback are blocked/
  );
  assert.deepEqual(calls, ['https://archive.example.test/plugin.zip']);
});

test('plugin archive download streams enforce the byte limit without buffering an oversized response', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-zip-limit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(32));
      controller.close();
    }
  }));
  await assert.rejects(
    fetchPluginArchive('https://archive.example.test/plugin.zip', { fetchImpl, lookupImpl: publicLookup, tmpRoot: root, maxBytes: 16 }),
    /archive is larger than/
  );
});

test('plugin archive follows only individually validated public redirects', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-zip-redirect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), redirect: options.redirect });
    if (String(url) === 'https://archive.example.test/plugin.zip') {
      return new Response(null, { status: 302, headers: { location: 'https://cdn.example.test/final.zip' } });
    }
    return new Response(minimalPluginZip(), { status: 200, headers: { 'content-type': 'application/zip' } });
  };
  const pluginRoot = await fetchPluginArchive('https://archive.example.test/plugin.zip', { fetchImpl, lookupImpl: publicLookup, tmpRoot: root });
  assert.equal(await readFile(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'), '{"name":"fixture"}');
  assert.deepEqual(calls.map((call) => call.url), [
    'https://archive.example.test/plugin.zip',
    'https://cdn.example.test/final.zip'
  ]);
  assert.ok(calls.every((call) => call.redirect === 'manual'));
  // Verify the normal extractor still handles a valid, contained ZIP.
  const extractRoot = path.join(root, 'extract');
  await extractZip(minimalPluginZip(), extractRoot);
  assert.equal(await readFile(path.join(extractRoot, '.claude-plugin', 'plugin.json'), 'utf8'), '{"name":"fixture"}');
});
