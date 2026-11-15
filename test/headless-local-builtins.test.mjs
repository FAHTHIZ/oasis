// `oasis -p /cost` (and /doctor, /help, ...) sent the text "/cost" to the model,
// which could only guess. Read-only built-ins now answer locally, as
// `claude -p /cost` does; custom commands and unknown names still go to the model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/oasis.mjs');

test('oasis -p /cost, /doctor and /help answer without a model call', async (t) => {
  const prompts = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      try { const messages = JSON.parse(body).messages || []; prompts.push(JSON.stringify(messages.at(-1))); } catch {}
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'model-answer' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-p-builtin-'));
  t.after(async () => { server.close(); await rm(home, { recursive: true, force: true }); });
  await mkdir(path.join(home, '.oasis', 'commands'), { recursive: true });
  await writeFile(path.join(home, '.oasis', 'commands', 'cost.md'), 'CUSTOM-COST-PROMPT\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_NO_UPDATE_CHECK: '1',
    OASIS_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/v1', OASIS_LOCAL_API_KEY: 'x', OASIS_MODEL: 'm', OASIS_PROTOCOL: 'openai' };
  const run = (args, cwd) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'oasis-p-builtin-cwd-'));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));

  let r = await run(['-p', '/cost'], elsewhere);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Session usage: 0 tokens/);
  r = await run(['-p', '/doctor'], elsewhere);
  assert.match(r.out, /Oasis doctor:/);
  r = await run(['-p', '/help'], elsewhere);
  assert.match(r.out, /Core workflows/);
  r = await run(['-p', '/cost', '--output-format', 'json'], elsewhere);
  const result = JSON.parse(r.out);
  assert.equal(result.type, 'result');
  assert.equal(result.is_error, false);
  assert.match(result.result, /Session usage/);
  assert.equal(prompts.length, 0, 'no model request for local built-ins');

  r = await run(['-p', '/nosuchcommand'], elsewhere);
  assert.match(r.out, /model-answer/);
  assert.equal(prompts.length, 1);
  // A project custom command with a built-in's name still wins.
  r = await run(['-p', '/cost'], home);
  assert.match(r.out, /model-answer/);
  assert.match(prompts.at(-1), /CUSTOM-COST-PROMPT/);
});
