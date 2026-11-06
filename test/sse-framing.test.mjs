import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';

// The CLI's provider stream follows EventSource framing: CR-only line ends,
// CRLF split across writes, comments, data spread over several lines, and a
// last event without its blank line.
test('CLI provider streams parse CR-only, split CRLF, multi-line data and an unterminated last event', async (t) => {
  const delta = (text) => JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] });
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const writes = [
      ': ping\r\r',
      'data: ' + delta('one ') + '\r', '\n\r', '\n',
      'data: ' + delta('two ') + '\r\r',
      'data: {"choices":[{"index":0,"delta":\ndata: {"content":"three"}}]}\n\n',
      'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n',
      'data: [DONE]'
    ];
    for (const chunk of writes) { res.write(chunk); await new Promise((resolve) => setTimeout(resolve, 5)); }
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-sse-'));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 2 }, permissionMode: 'bypassPermissions' });
  t.after(async () => { closeSession(session); await rm(root, { recursive: true, force: true }); });
  const turn = await runAgentTurn(session, 'hi', { onText: () => {}, onDelta: () => {} });
  assert.equal(String(turn.text || turn.content || '').trim(), 'one two three');
});
