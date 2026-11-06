import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LspClient } from '../src/lsp.mjs';

// Minimal LSP server: answers echo, never answers slow, records cancellations,
// asks the client for configuration, and returns an error for fail.
const SERVER = `
let buf = Buffer.alloc(0); const seen = [];
const send = (m) => { const b = Buffer.from(JSON.stringify(m)); process.stdout.write('Content-Length: ' + b.length + '\\r\\n\\r\\n'); process.stdout.write(b); };
process.stdin.on('data', (c) => { buf = Buffer.concat([buf, c]); for (;;) {
  const h = buf.indexOf('\\r\\n\\r\\n'); if (h < 0) return; const n = Number(/content-length: *(\\d+)/i.exec(buf.slice(0, h))[1]);
  if (buf.length < h + 4 + n) return; const m = JSON.parse(buf.slice(h + 4, h + 4 + n).toString()); buf = buf.slice(h + 4 + n); seen.push(m.method || 'response');
  if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: { capabilities: { hoverProvider: true } } }); send({ jsonrpc: '2.0', id: 900, method: 'workspace/configuration', params: { items: [{}, {}] } }); }
  else if (m.method === 'echo') send({ jsonrpc: '2.0', id: m.id, result: { text: m.params.text + ' — ওয়েসিস 🚀' } });
  else if (m.method === 'fail') send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } });
  else if (m.method === 'seen') send({ jsonrpc: '2.0', id: m.id, result: seen });
  else if (m.method === 'shutdown') send({ jsonrpc: '2.0', id: m.id, result: null });
  else if (m.method === 'exit') process.exit(0);
  else if (m.id === 900) seen.push('config:' + JSON.stringify(m.result));
} });`;

test('LSP transport frames UTF-8, cancels timed-out requests and answers server requests', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oasis-lsp-transport-'));
  const file = path.join(dir, 'server.cjs');
  await writeFile(file, SERVER);
  const client = new LspClient({ command: process.execPath, args: [file], cwd: dir, env: process.env, name: 'mini' });
  try {
    await client.start();
    assert.deepEqual(await client.initialize(), { hoverProvider: true });
    assert.deepEqual(await client.request('echo', { text: 'হ্যালো' }), { text: 'হ্যালো — ওয়েসিস 🚀' });
    await assert.rejects(client.request('fail', {}), /mini: no such method/);
    await assert.rejects(client.request('slow', {}, 200), /mini did not answer slow within 0s/);
    const seen = await client.request('seen', {});
    assert.ok(seen.includes('$/cancelRequest'), 'timeout sends $/cancelRequest: ' + seen.join(','));
    assert.ok(seen.includes('config:[null,null]'), 'answers workspace/configuration: ' + seen.join(','));
  } finally {
    await client.stop();
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(client.child.exitCode, 0, 'graceful shutdown + exit');
  await assert.rejects(client.request('echo', { text: 'x' }), /not running/);
});
