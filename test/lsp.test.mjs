import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runLsp, stopLspClients, locateSymbol, serverForFile, verifyEditedFileWithLsp } from '../src/lsp.mjs';
import { TOOL_DEFINITIONS } from '../src/tools.mjs';
import { loadSettings } from '../src/settings.mjs';

// A tiny stdio language server: enough protocol to exercise the client.
const FAKE_SERVER = String.raw`
let buf = Buffer.alloc(0); const docs = new Map();
const send = (m) => { const b = Buffer.from(JSON.stringify(m)); process.stdout.write('Content-Length: ' + b.length + '\r\n\r\n'); process.stdout.write(b); };
const word = (uri, pos) => { const line = (docs.get(uri) || '').split('\n')[pos.line] || ''; let s = pos.character, e = pos.character; while (s > 0 && /\w/.test(line[s - 1])) s--; while (e < line.length && /\w/.test(line[e])) e++; return line.slice(s, e); };
const find = (name) => { const out = []; for (const [uri, text] of docs) text.split('\n').forEach((line, i) => { const re = new RegExp('\\b' + name + '\\b', 'g'); let m; while ((m = re.exec(line))) out.push({ uri, range: { start: { line: i, character: m.index }, end: { line: i, character: m.index + name.length } } }); }); return out; };
const decl = (name) => find(name).find((loc) => /function|class/.test((docs.get(loc.uri) || '').split('\n')[loc.range.start.line]));
function handle(m) {
  const p = m.params || {};
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { capabilities: { definitionProvider: true, referencesProvider: true, hoverProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true } } });
  if (m.method === 'textDocument/didOpen' || m.method === 'textDocument/didChange') {
    const uri = p.textDocument.uri; const text = m.method === 'textDocument/didOpen' ? p.textDocument.text : p.contentChanges[0].text; docs.set(uri, text);
    const diagnostics = []; text.split('\n').forEach((line, i) => {
      const c = line.indexOf('BAD');
      if (c >= 0) diagnostics.push({ range: { start: { line: i, character: c }, end: { line: i, character: c + 3 } }, severity: 1, message: 'BAD is not allowed', code: 'X1', source: 'fake' });
      const badType = line.indexOf('"bad"');
      if (/const value: number = "bad";/.test(line)) diagnostics.push({ range: { start: { line: i, character: badType }, end: { line: i, character: badType + 5 } }, severity: 1, message: "Type 'string' is not assignable to type 'number'.", code: 'TS2322', source: 'typescript' });
    });
    if (!text.includes('NO_DIAGS')) return send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
  }
  if (m.method === 'textDocument/definition') return send({ jsonrpc: '2.0', id: m.id, result: decl(word(p.textDocument.uri, p.position)) || null });
  if (m.method === 'textDocument/references') return send({ jsonrpc: '2.0', id: m.id, result: find(word(p.textDocument.uri, p.position)) });
  if (m.method === 'textDocument/hover') return send({ jsonrpc: '2.0', id: m.id, result: { contents: { kind: 'markdown', value: 'symbol **' + word(p.textDocument.uri, p.position) + '**' } } });
  if (m.method === 'textDocument/documentSymbol') { const out = []; (docs.get(p.textDocument.uri) || '').split('\n').forEach((line, i) => { const f = line.match(/function (\w+)/); if (f) out.push({ name: f[1], kind: 12, range: { start: { line: i, character: 0 }, end: { line: i, character: line.length } }, selectionRange: { start: { line: i, character: line.indexOf(f[1]) }, end: { line: i, character: 0 } } }); }); return send({ jsonrpc: '2.0', id: m.id, result: out }); }
  if (m.method === 'workspace/symbol') { const loc = decl(p.query); return send({ jsonrpc: '2.0', id: m.id, result: loc ? [{ name: p.query, kind: 12, location: loc }] : [] }); }
  if (m.method === 'shutdown') return send({ jsonrpc: '2.0', id: m.id, result: null });
  if (m.method === 'exit') process.exit(0);
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unsupported' } });
}
process.stdin.on('data', (c) => { buf = Buffer.concat([buf, c]); for (;;) { const h = buf.indexOf('\r\n\r\n'); if (h < 0) return; const n = Number(/Content-Length: (\d+)/i.exec(buf.slice(0, h).toString())[1]); if (buf.length < h + 4 + n) return; const body = buf.slice(h + 4, h + 4 + n).toString(); buf = buf.slice(h + 4 + n); handle(JSON.parse(body)); } });
`;

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), 'oasis-lsp-'));
  const server = path.join(root, 'fake-server.cjs');
  await writeFile(server, FAKE_SERVER);
  await writeFile(path.join(root, 'lib.fake'), 'function helper() {}\nfunction other() { helper(); }\n');
  await writeFile(path.join(root, 'main.fake'), 'helper();\nconst x = BAD;\n');
  const settings = { lspServers: { fake: { command: process.execPath, args: [server], extensions: ['.fake'] } } };
  return { root, settings };
}

test('lsp tool is registered and read-only', async () => {
  assert.ok(TOOL_DEFINITIONS.some((tool) => tool.function.name === 'lsp'));
});

test('locateSymbol finds whole-word occurrences, optionally on a line', () => {
  const text = 'const addAll = 1;\nadd(2);\nfoo.add(3)';
  assert.deepEqual(locateSymbol(text, 'add'), { line: 1, character: 0 });
  assert.deepEqual(locateSymbol(text, 'add', 3), { line: 2, character: 4 });
  assert.throws(() => locateSymbol(text, 'missing'), /not found/);
});

test('builtin server mapping by extension', () => {
  assert.equal(serverForFile('src/a.tsx').name, 'typescript');
  assert.equal(serverForFile('a.py').name, 'python');
  assert.equal(serverForFile('main.go').name, 'go');
  assert.equal(serverForFile('lib.rs').name, 'rust');
  assert.equal(serverForFile('README'), null);
});

test('definition, references, hover, symbols and diagnostics through a language server', async () => {
  const { root, settings } = await project();
  const session = { settings };
  const options = { session, settings, autoApprove: true };
  try {
    // The fake server only knows files it has been sent, so open lib.fake first.
    const symbols = await runLsp(root, { operation: 'document_symbols', path: 'lib.fake' }, options);
    assert.deepEqual(symbols.symbols.map((s) => s.name + ':' + s.kind), ['helper:function', 'other:function']);
    const def = await runLsp(root, { operation: 'definition', path: 'main.fake', symbol: 'helper' }, options);
    assert.equal(def.locations.length, 1);
    assert.deepEqual({ path: def.locations[0].path, line: def.locations[0].line, column: def.locations[0].column }, { path: 'lib.fake', line: 1, column: 10 });
    assert.equal(def.locations[0].text, 'function helper() {}');
    const refs = await runLsp(root, { operation: 'references', path: 'lib.fake', line: 1, column: 12 }, options);
    assert.equal(refs.locations.length, 3);
    const hover = await runLsp(root, { operation: 'hover', path: 'main.fake', symbol: 'helper' }, options);
    assert.equal(hover.hover, 'symbol **helper**');
    const ws = await runLsp(root, { operation: 'workspace_symbols', path: 'main.fake', query: 'other' }, options);
    assert.equal(ws.symbols[0].path, 'lib.fake');
    const diags = await runLsp(root, { operation: 'diagnostics', path: 'main.fake' }, options);
    assert.equal(diags.summary.errors, 1);
    assert.equal(diags.diagnostics[0].line, 2);
    // The same server is reused, and edits on disk are re-synced before the next request.
    assert.equal(session.lspClients.size, 1);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await writeFile(path.join(root, 'main.fake'), 'helper();\nconst x = 1;\n');
    const clean = await runLsp(root, { operation: 'diagnostics', path: 'main.fake' }, options);
    assert.equal(clean.summary.total, 0);
  } finally {
    await stopLspClients(session);
  }
});

test('post-edit verification surfaces an introduced TypeScript diagnostic', async () => {
  const { root } = await project();
  const server = path.join(root, 'fake-server.cjs');
  const settings = { lspServers: { fakeTypescript: { command: process.execPath, args: [server], extensions: ['.ts'], languageId: 'typescript' } } };
  await writeFile(path.join(root, 'main.ts'), 'const value: number = 1;\n');
  const session = { settings };
  const options = { session, settings, autoApprove: true };
  try {
    const baseline = await runLsp(root, { operation: 'diagnostics', path: 'main.ts' }, options);
    assert.equal(baseline.summary.errors, 0);
    await writeFile(path.join(root, 'main.ts'), 'const value: number = "bad";\n');
    const result = await verifyEditedFileWithLsp(root, 'main.ts', { ...options, baselineDiagnostics: baseline.diagnostics });
    assert.equal(result.status, 'issues');
    assert.equal(result.baselineKnown, true);
    assert.equal(result.newErrors.length, 1);
    assert.equal(result.newErrors[0].code, 'TS2322');
    assert.equal(result.newErrors[0].line, 1);
  } finally {
    await stopLspClients(session);
  }
});

test('post-edit diagnostics time out as unavailable when a server does not answer', async () => {
  const { root, settings } = await project();
  const session = { settings };
  await writeFile(path.join(root, 'main.fake'), 'NO_DIAGS\n');
  try {
    const result = await verifyEditedFileWithLsp(root, 'main.fake', {
      session, settings, autoApprove: true, diagnosticTimeoutMs: 20
    });
    assert.equal(result.status, 'unavailable');
    assert.match(result.reason, /Timed out waiting|did not provide current diagnostics/i);
  } finally {
    await stopLspClients(session);
  }
});


test('starting a server needs approval once per session', async () => {
  const { root, settings } = await project();
  const denied = { settings };
  let asked = 0;
  await assert.rejects(runLsp(root, { operation: 'hover', path: 'main.fake', symbol: 'helper' }, { session: denied, settings, approval: async () => { asked++; return false; } }), /not approved/);
  assert.equal(asked, 1);
  const session = { settings };
  asked = 0;
  const approval = async () => { asked++; return true; };
  try {
    await runLsp(root, { operation: 'hover', path: 'main.fake', symbol: 'helper' }, { session, settings, approval });
    await runLsp(root, { operation: 'definition', path: 'main.fake', symbol: 'helper' }, { session, settings, approval });
    assert.equal(asked, 1);
  } finally { await stopLspClients(session); }
});

test('rejects unknown file types, protected files, and paths outside the workspace', async () => {
  const { root } = await project();
  await writeFile(path.join(root, 'notes.unknownext'), 'x');
  await writeFile(path.join(root, '.env'), 'SECRET=1');
  await assert.rejects(runLsp(root, { operation: 'hover', path: 'notes.unknownext', line: 1, column: 1 }, { autoApprove: true }), /No language server/);
  await assert.rejects(runLsp(root, { operation: 'hover', path: '.env', line: 1, column: 1 }, { autoApprove: true }), /protected|sensitive/);
  await assert.rejects(runLsp(root, { operation: 'hover', path: '../x.ts', line: 1, column: 1 }, { autoApprove: true }), /workspace|outside|escape/i);
});

test('lspServers are only honoured from trusted settings', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'oasis-lsp-settings-'));
  const home = await mkdtemp(path.join(tmpdir(), 'oasis-lsp-home-'));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(root, '.oasis'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'settings.json'), JSON.stringify({ lspServers: { evil: { command: '/bin/sh', extensions: ['.ts'] } } }));
  const settings = await loadSettings(root, { env: { HOME: home, OASIS_HOME: path.join(home, '.oasis') } });
  assert.deepEqual(settings.lspServers, {});
  assert.ok(settings.ignoredUntrusted.length >= 1);
});
