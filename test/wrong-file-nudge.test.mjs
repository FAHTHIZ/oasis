import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn, requestedNewFile, wrongFileNudge } from '../src/agent.mjs';

test('the file a create request names is recognized', () => {
  assert.equal(requestedNewFile('Create src/lib.mjs exporting isSafeTaskId(value)'), 'src/lib.mjs');
  assert.equal(requestedNewFile('please write a new file called `tools/build.py` that zips dist'), 'tools/build.py');
  assert.equal(requestedNewFile('add README.md, a short one'), 'README.md');
  assert.equal(requestedNewFile('fix src/lib.mjs'), '');
  assert.equal(requestedNewFile('Create a helper for parsing flags'), '');
  assert.equal(requestedNewFile('create ../outside.js'), '');
});

test('the nudge fires only when a different file was created and the named one is missing', () => {
  const v = (created, changed = created) => ({ createdPaths: new Set(created), changedPaths: new Set(changed) });
  const request = 'Create src/lib.mjs exporting f';
  assert.match(wrongFileNudge(request, v(['src/utils.mjs']), () => false), /asks for src\/lib\.mjs, but you created src\/utils\.mjs/);
  assert.equal(wrongFileNudge(request, v(['src/lib.mjs']), () => false), '');
  assert.equal(wrongFileNudge(request, v(['src/utils.mjs']), () => true), '', 'named file already exists');
  assert.equal(wrongFileNudge(request, v([]), () => false), '', 'nothing created');
  assert.equal(wrongFileNudge('make the tests pass', v(['a.js']), () => false), '');
});

test('a model that writes the wrong file is told once, then fixes it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-wrongfile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payloads = [];
  const write = (id, file) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: file, content: 'export const f = () => 1;\n' }) } }] });
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    payloads.push(JSON.parse(body));
    const n = payloads.length;
    const message = n === 1 ? write('w1', 'src/utils.mjs')
      : n === 2 ? { role: 'assistant', content: 'Created the helper.' }
      : n === 3 ? write('w2', 'src/lib.mjs')
      : { role: 'assistant', content: 'Created src/lib.mjs.' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 8 } });
  const result = await runAgentTurn(session, 'Create src/lib.mjs exporting f()', { autoApprove: true });
  assert.ok(payloads.length >= 4);
  assert.equal(payloads.flatMap((p) => p.messages).filter((m) => m.role === "user" && /asks for src\/lib/.test(m.content)).length > 0, true);
  assert.equal(payloads.slice(3).some((p) => /asks for src\/lib/.test(String(p.messages.at(-1).content))), false, "nudged only once");
  const nudge = payloads[2].messages[payloads[2].messages.length - 1];
  assert.equal(nudge.role, 'user');
  assert.match(nudge.content, /asks for src\/lib\.mjs, but you created src\/utils\.mjs/);
  assert.ok(existsSync(path.join(root, 'src', 'lib.mjs')));
  assert.match(await readFile(path.join(root, 'src', 'lib.mjs'), 'utf8'), /export const f/);
  assert.match(result.text, /src\/lib\.mjs/);
});
