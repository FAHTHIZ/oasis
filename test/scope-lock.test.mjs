import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setEditScope, scopeViolation } from '../src/scope-lock.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';

test('scope patterns accept globs, directories, and exact files', () => {
  const session = { root: '/repo' };
  setEditScope(session, 'src/parser ./test/**/*.test.mjs README.md');
  assert.equal(scopeViolation(session, 'edit_file', { path: 'src/parser/index.mjs' }), '');
  assert.equal(scopeViolation(session, 'write_file', { path: 'test/unit/a.test.mjs' }), '');
  assert.equal(scopeViolation(session, 'edit_file', { path: 'README.md' }), '');
  assert.match(scopeViolation(session, 'edit_file', { path: 'src/server.mjs' }), /Scope lock/);
  assert.match(scopeViolation(session, 'delete_file', { path: '../outside.txt' }), /Scope lock/);
  assert.equal(scopeViolation(session, 'read_file', { path: 'src/server.mjs' }), '', 'reads are never restricted');
});

test('/scope command sets, shows, and clears the lock; agent edits outside it are refused', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'a.js'), 'a\n');
  await writeFile(path.join(root, 'b.js'), 'b\n');
  const payloads = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    payloads.push(JSON.parse(body));
    const step = payloads.length;
    const call = (id, file) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: file, content: 'changed\n' }) } }] });
    const message = step === 1 ? call('w1', 'b.js') : step === 2 ? call('w2', 'src/a.js') : { role: 'assistant', content: 'done' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 6, requireReadBeforeEdit: false } });
  const set = await runBuiltinCommand('scope', 'src/**', { root, session });
  assert.match(set.output, /locked to: src\/\*\*/);
  await runAgentTurn(session, 'Update files.', { autoApprove: true });
  assert.equal(await readFile(path.join(root, 'b.js'), 'utf8'), 'b\n', 'out-of-scope file untouched');
  assert.equal(await readFile(path.join(root, 'src', 'a.js'), 'utf8'), 'changed\n', 'in-scope file changed');
  const firstUser = payloads[0].messages.filter((m) => m.role === 'user').pop();
  assert.match(String(firstUser.content), /Scope lock is active/);
  const toolMessages = payloads[2].messages.filter((m) => m.role === 'tool');
  assert.match(String(toolMessages[0].content), /Scope lock: write_file on \\?"b\.js\\?"/);
  assert.match((await runBuiltinCommand('scope', 'off', { root, session })).output, /cleared/);
  assert.equal(session.editScope, undefined);
});
