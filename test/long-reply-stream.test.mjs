import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';

const sse = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';

// A long answer (a whole file, a long report) used to stop streaming at 24k
// characters, so the CLI, ACP and the browser showed a cut-off reply.
test('a reply longer than 24k characters streams in full', async (t) => {
  const line = 'Line of a long generated report that keeps going.\n';
  const chunks = Array.from({ length: 1200 }, (_, i) => i + ': ' + line);
  const full = chunks.join('');
  assert.ok(full.length > 60000);
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const content of chunks) res.write(sse({ choices: [{ delta: { content } }] }));
    res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-long-'));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 2 }, permissionMode: 'bypassPermissions' });
  t.after(async () => { closeSession(session); await rm(root, { recursive: true, force: true }); });
  let last = '';
  const result = await runAgentTurn(session, 'write it', { onDelta: (text) => { last = text; } });
  assert.equal(result.text.trim(), full.trim());
  assert.equal(last.trim(), full.trim());
});
