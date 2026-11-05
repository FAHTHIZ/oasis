import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.mjs');

function mockOllama() {
  return http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/api/tags')) return res.end(JSON.stringify({ models: [{ name: 'qwen3-coder:30b' }, { name: 'llama3.2:3b' }] }));
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3-coder:30b' }, { id: 'llama3.2:3b' }] }));
    if (req.url.includes('chat/completions')) {
      const request = JSON.parse(body || '{}');
      const tool = (request.tools || [])[0];
      const args = {};
      for (const [key, schema] of Object.entries(tool && tool.function.parameters && tool.function.parameters.properties || {})) args[key] = schema.enum ? schema.enum[0] : (schema.type === 'number' || schema.type === 'integer' ? 1 : 'x');
      const message = tool ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: tool.function.name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'ok' };
      return res.end(JSON.stringify({ id: '1', object: 'chat.completion', model: request.model, choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    }
    res.statusCode = 404; res.end('{}');
  });
}

function run(args, input, home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, OASIS_HOME: path.join(home, '.oasis'), NO_COLOR: '1' };
  for (const key of Object.keys(env)) if ((key.startsWith('OASIS_') && key !== 'OASIS_HOME') || key.endsWith('_API_KEY')) delete env[key];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

test('oasis connect: a pasted local server address locks in the best model with backups', async () => {
  const server = mockOllama();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-connect-'));
  try {
    const url = 'http://127.0.0.1:' + server.address().port + '/v1';
    const { code, out } = await run(['connect'], url + '\n', home);
    assert.equal(code, 0, out);
    assert.match(out, /Locked in qwen3-coder:30b/);
    assert.match(out, /1 backup model ready/);
    const config = JSON.parse(await readFile(path.join(home, '.oasis', 'config.json'), 'utf8'));
    assert.equal(config.model, 'qwen3-coder:30b');
    assert.equal(config.baseURL, url);
    assert.equal(config.fallbackModel, 'llama3.2:3b');
  } finally {
    server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('oasis connect: a GitHub token gets a clear message and nothing is saved', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-connect-'));
  try {
    const { code, out } = await run(['connect'], 'ghp_' + 'a'.repeat(36) + '\n', home);
    assert.notEqual(code, 0);
    assert.match(out, /GitHub token, not a model key/);
    await assert.rejects(readFile(path.join(home, '.oasis', 'config.json')));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
