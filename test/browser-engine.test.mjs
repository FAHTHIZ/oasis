// The browser engine layer: choosing Obscura or Chrome, installing the pinned
// Obscura release safely, and the protocol details Obscura needs (flattened
// sessions, events tagged with the target's default session).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolveEngine, enginePreference, findObscura, installObscura, obscuraInstallDir, OBSCURA_RELEASE } from '../src/browser-engine.mjs';
import { CdpConnection, CdpPage } from '../src/cdp.mjs';
import { safeFileName, fileNameFromDisposition, isPrivateBrowserRequest } from '../src/browser-tool.mjs';

async function fakeBinary(dir, name) {
  const file = path.join(dir, name);
  await writeFile(file, '#!/bin/sh\necho ' + name + '\n');
  await chmod(file, 0o755);
  return file;
}

test('engine preference reads OASIS_BROWSER_ENGINE and ignores unknown values', () => {
  assert.equal(enginePreference({}), 'auto');
  assert.equal(enginePreference({ OASIS_BROWSER_ENGINE: 'Obscura' }), 'obscura');
  assert.equal(enginePreference({ OASIS_BROWSER_ENGINE: 'chromium' }), 'chrome');
  assert.equal(enginePreference({ OASIS_BROWSER_ENGINE: 'netscape' }), 'auto');
});

test('auto picks Obscura when installed, Chrome for visible windows, and says why', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-engine-'));
  const obscura = await fakeBinary(dir, 'obscura');
  const chrome = await fakeBinary(dir, 'chrome');
  const env = { HOME: dir, OASIS_OBSCURA_PATH: obscura, OASIS_CHROME_PATH: chrome };
  assert.deepEqual([resolveEngine({ env }).engine, resolveEngine({ env }).executable], ['obscura', obscura]);
  assert.equal(resolveEngine({ env, visible: true }).engine, 'chrome');
  assert.equal(resolveEngine({ env: { ...env, OASIS_BROWSER_ENGINE: 'chrome' } }).engine, 'chrome');
  assert.equal(resolveEngine({ env, attachPort: 9222 }).engine, 'chrome');
  const noObscura = resolveEngine({ env: { HOME: dir, OASIS_CHROME_PATH: chrome, OASIS_OBSCURA_CACHE: path.join(dir, 'none'), PATH: '' } });
  assert.equal(noObscura.engine, 'chrome');
  assert.match(noObscura.reason, /not installed/);
});

test('an explicit OASIS_OBSCURA_PATH that does not exist is not silently replaced', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-engine-'));
  assert.equal(findObscura({ HOME: dir, OASIS_OBSCURA_PATH: path.join(dir, 'missing'), PATH: '' }), null);
});

test('installObscura refuses an archive whose SHA-256 does not match the pin and leaves nothing behind', async (t) => {
  const platform = process.platform === 'win32' ? 'win32' : 'linux';
  const arch = 'x64';
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-install-'));
  const env = { HOME: dir, OASIS_OBSCURA_CACHE: path.join(dir, 'cache') };
  let asked = '';
  const fetchImpl = async (url) => { asked = url; return new Response('not the real archive'); };
  await assert.rejects(installObscura({ env, platform, arch, fetchImpl }), /did not match its pinned SHA-256/);
  assert.ok(asked.startsWith(OBSCURA_RELEASE.base), 'downloads only from the pinned release: ' + asked);
  assert.equal(existsSync(obscuraInstallDir(env, platform)), false);
  const leftovers = await readdir(env.OASIS_OBSCURA_CACHE).catch(() => []);
  assert.deepEqual(leftovers, [], 'temporary install folders are removed');
  t.diagnostic('pinned ' + OBSCURA_RELEASE.tag);
});

test('installObscura refuses a failed download and unknown platforms', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-install-'));
  const env = { HOME: dir, OASIS_OBSCURA_CACHE: path.join(dir, 'cache') };
  await assert.rejects(installObscura({ env, platform: 'linux', arch: 'x64', fetchImpl: async () => new Response('', { status: 404 }) }), /Could not download Obscura \(404\)/);
  await assert.rejects(installObscura({ env, platform: 'aix', arch: 'ppc64', fetchImpl: async () => { throw new Error('no fetch expected'); } }), /no prebuilt release/);
});

function fakeSocket() {
  const sent = [];
  const ws = { sent, send: (text) => sent.push(JSON.parse(text)), close() {}, onmessage: null, onclose: null };
  return ws;
}

test('events Obscura tags with the default session reach the attached tab once', () => {
  const ws = fakeSocket();
  const connection = new CdpConnection(ws);
  const page = new CdpPage(connection, 'page-1-session-1', { targetId: 'page-1' });
  const paused = [];
  const navigated = [];
  page.on('Fetch.requestPaused', (p) => paused.push(p.requestId));
  page.on('Page.frameNavigated', (p) => navigated.push(p.frame.url));
  const event = (sessionId, method, params) => ws.onmessage(JSON.stringify({ method, params, sessionId }));
  // Only on the default session: still delivered, or the paused request stalls the page.
  event('page-1-session', 'Fetch.requestPaused', { requestId: 'r1', request: { url: 'https://a.test/' } });
  // On both sessions: delivered once.
  event('page-1-session', 'Page.frameNavigated', { frame: { id: 'page-1', url: 'https://a.test/' } });
  event('page-1-session-1', 'Page.frameNavigated', { frame: { id: 'page-1', url: 'https://a.test/' } });
  // A session for some other target is not ours.
  event('page-2-session', 'Fetch.requestPaused', { requestId: 'r2', request: { url: 'https://b.test/' } });
  assert.deepEqual(paused, ['r1']);
  assert.deepEqual(navigated, ['https://a.test/']);
});

test('commands carry the session id and a closed connection rejects pending calls', async () => {
  const ws = fakeSocket();
  const connection = new CdpConnection(ws);
  const page = new CdpPage(connection, 's-1', { targetId: 't-1' });
  const reply = page.send('Runtime.evaluate', { expression: '1' });
  assert.equal(ws.sent[0].sessionId, 's-1');
  ws.onmessage(JSON.stringify({ id: ws.sent[0].id, result: { result: { value: 1 } }, sessionId: 's-1' }));
  assert.deepEqual(await reply, { result: { value: 1 } });
  const pending = page.send('Page.navigate', { url: 'https://a.test/' });
  ws.onclose();
  await assert.rejects(pending, /closed/);
  await assert.rejects(page.send('Page.reload'), /closed/);
});

test('download names are made safe and read from Content-Disposition', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('a\u0000b<c>.txt'), 'a_b_c_.txt');
  assert.equal(safeFileName(''), 'download');
  assert.equal(safeFileName('CON'), '_CON');
  assert.equal(fileNameFromDisposition('attachment; filename="report.pdf"'), 'report.pdf');
  assert.equal(fileNameFromDisposition("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"), 'résumé.pdf');
  assert.equal(fileNameFromDisposition('inline'), '');
});

test('private-address checks resolve every record and a custom resolver is never cached', async () => {
  let calls = 0;
  const lookup = async () => { calls += 1; return [{ address: '93.184.216.34', family: 4 }, { address: calls > 1 ? '10.0.0.5' : '2606:2800::1', family: calls > 1 ? 4 : 6 }]; };
  assert.equal(await isPrivateBrowserRequest('https://rebind.test/', lookup), false);
  assert.equal(await isPrivateBrowserRequest('https://rebind.test/', lookup), true, 'a later private answer is seen');
  assert.equal(calls, 2);
  assert.equal(await isPrivateBrowserRequest('http://169.254.169.254/latest/meta-data'), true);
  assert.equal(await isPrivateBrowserRequest('http://localhost:3000/'), true);
});
