import test from 'node:test';
import assert from 'node:assert/strict';
import { splitThinking, createThinkFilter, visibleReply } from '../app/core/think-tags.mjs';

test('splitThinking removes a leading reasoning block', () => {
  assert.deepEqual(splitThinking('<thought>plan it</thought>Hello'), { content: 'Hello', reasoning: 'plan it' });
  assert.deepEqual(splitThinking('\n<think>\na\n</think>\n\nDone.'), { content: 'Done.', reasoning: 'a' });
  assert.equal(splitThinking('<THINKING>x</THINKING>y').content, 'y');
});

test('splitThinking leaves replies that only mention tags alone', () => {
  const text = 'Models such as R1 emit <think> tags before answering.';
  assert.deepEqual(splitThinking(text), { content: text, reasoning: '' });
  assert.equal(splitThinking('').content, '');
  assert.equal(splitThinking(null).content, '');
});

test('splitThinking treats an unclosed block as all reasoning', () => {
  assert.deepEqual(splitThinking('<think>still going'), { content: '', reasoning: 'still going' });
});

test('splitThinking handles several leading blocks', () => {
  assert.deepEqual(splitThinking('<think>a</think><thought>b</thought>ok'), { content: 'ok', reasoning: 'a\n\nb' });
});

function streamed(chunks) {
  let text = '';
  let thinking = '';
  const filter = createThinkFilter((c) => { text += c; }, (c) => { thinking += c; });
  for (const chunk of chunks) filter.push(chunk);
  filter.flush();
  return { text, thinking };
}

test('createThinkFilter hides reasoning split across any chunk boundary', () => {
  const full = '<thought>I should greet.</thought>Hello there';
  for (let size = 1; size <= full.length; size++) {
    const chunks = [];
    for (let i = 0; i < full.length; i += size) chunks.push(full.slice(i, i + size));
    const out = streamed(chunks);
    assert.equal(out.text, 'Hello there', 'chunk size ' + size);
    assert.equal(out.thinking, 'I should greet.', 'chunk size ' + size);
  }
});

test('createThinkFilter passes ordinary text through, including later tags', () => {
  assert.equal(streamed(['Use ', '<think>', ' tags']).text, 'Use <think> tags');
  assert.equal(streamed(['<b>bold</b>']).text, '<b>bold</b>');
  assert.equal(streamed(['<thi', 's is not a tag']).text, '<this is not a tag');
});

test('createThinkFilter drops an unclosed block at flush', () => {
  assert.deepEqual(streamed(['<think>never ', 'finished']), { text: '', thinking: 'never finished' });
});

test('visibleReply hides a tag that is still arriving', () => {
  assert.equal(visibleReply('<tho'), '');
  assert.equal(visibleReply('<thought>abc'), '');
  assert.equal(visibleReply('<thought>abc</thought>Hi'), 'Hi');
  assert.equal(visibleReply('Hi'), 'Hi');
});

test('oasis -p prints the answer without Gemma-style thoughts', async () => {
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '<thought>secret plan</thought>Final answer.' }, finish_reason: 'stop' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const piece of ['<tho', 'ught>secret ', 'plan</tho', 'ught>Final ', 'answer.']) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'oasis-think-'));
  try {
    const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/v1', OASIS_MODEL: 'gemma-4-31b-it', OASIS_API_KEY: '', OASIS_SANDBOX: '0' };
    const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
    const child = spawn(process.execPath, [cli, '-p', 'hi'], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0, err);
    assert.match(out, /Final answer\./);
    assert.doesNotMatch(out + err, /secret plan|<thought>/);
  } finally {
    server.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('the browser app streams and returns replies without thoughts', async () => {
  const { chat } = await import('../app/core/providers.mjs');
  const sse = (pieces) => new Response(pieces.map((p) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: p } }] }) + '\n\n').join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const config = { protocol: 'openai', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'k', model: 'gemma-4-31b-it' };
  let shown = '';
  const reply = await chat(config, { messages: [{ role: 'user', content: 'hi' }], onText: (t) => { shown += t; }, fetchImpl: async () => sse(['<thou', 'ght>hidden</thought>', 'Hi ', 'there']) });
  assert.equal(reply.content, 'Hi there');
  assert.equal(shown, 'Hi there');
});
