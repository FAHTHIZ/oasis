import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scriptedModel } from './helpers/scripted-model.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

// @anthropic-ai/claude-agent-sdk 0.3.x launches the CLI with stream-json in and
// out, `--permission-mode=MODE` in equals form, and no -p.
test('the Claude Agent SDK launch line (stream-json both ways, no -p) runs headless', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-claude-sdk-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-claude-sdk-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const { config } = await scriptedModel(t, [{ content: 'hello from oasis' }]);
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_API_KEY: '', OASIS_SANDBOX: '0', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' };
  const child = spawn(process.execPath, [CLI, '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--permission-mode=acceptEdits'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
    if (out.includes('"subtype":"turn"')) child.stdin.end();
  });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'say hello' }, parent_tool_use_id: null, session_id: '' }) + '\n');
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, err);
  const events = out.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
  assert.equal(init.permission_mode, 'acceptEdits');
  const result = events.at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.subtype, 'success');
  assert.equal(result.result, 'hello from oasis');
});
