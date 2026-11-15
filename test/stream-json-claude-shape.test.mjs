// Streamed assistant events were {type:'assistant', text} only; a consumer
// written for `claude -p --output-format stream-json` reads message.content and
// saw no text at all. They now carry both shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/oasis.mjs');

test('stream-json assistant events carry Claude Code message.content as well as text', async (t) => {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'hello there' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-streamjson-'));
  t.after(async () => { server.close(); await rm(home, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_NO_UPDATE_CHECK: '1',
    OASIS_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/v1', OASIS_LOCAL_API_KEY: 'x', OASIS_MODEL: 'm', OASIS_PROTOCOL: 'openai' };
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '-p', 'hi', '--output-format', 'stream-json'], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    child.on('close', () => resolve(text));
  });
  const events = out.trim().split('\n').map((line) => JSON.parse(line));
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
  const assistant = events.filter((event) => event.type === 'assistant');
  assert.ok(assistant.length, out);
  // Claude Code consumer: join the text blocks of assistant messages.
  const claudeText = assistant.flatMap((event) => (event.message && event.message.content) || []).filter((block) => block.type === 'text').map((block) => block.text).join('');
  assert.equal(claudeText, 'hello there');
  assert.equal(assistant.map((event) => event.text).join(''), 'hello there');
  assert.equal(assistant[0].message.role, 'assistant');
  assert.equal(assistant[0].session_id, init.session_id);
  assert.equal(events.at(-1).type, 'result');
});
