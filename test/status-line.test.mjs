import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { renderStatusLine, statusLinePayload } from '../src/status-line.mjs';
import { loadSettings, setWorkspaceTrust } from '../src/settings.mjs';

test('status line command receives session JSON and its first line is shown', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = statusLinePayload({ root, config: { model: 'gpt-x' }, usage: { totalTokens: 42, inputTokens: 30, outputTokens: 12, requests: 2 }, outputStyle: 'learning' });
  assert.equal(payload.model.display_name, 'gpt-x');
  assert.equal(payload.output_style.name, 'learning');
  const command = process.execPath + ' -e "let d=\'\';process.stdin.on(\'data\',c=>d+=c).on(\'end\',()=>{const j=JSON.parse(d);console.log(\'\\n\\x1b[32m\'+j.model.id+\' | \'+j.cost.total_tokens+\' tokens\\x1b[0m\');console.log(\'second\')})"';
  assert.equal(await renderStatusLine({ type: 'command', command }, payload, { root }), 'gpt-x | 42 tokens');
  assert.equal(await renderStatusLine({ type: 'command', command }, payload, { root, keepColor: true }), '\x1b[32mgpt-x | 42 tokens\x1b[0m');
  assert.equal(await renderStatusLine({ type: 'command', command: 'exit 3' }, payload, { root }), null);
  assert.equal(await renderStatusLine(null, payload, { root }), null);
});

test('statusLine from project settings needs a trusted workspace', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-status-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-status-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const env = { ...process.env, OASIS_CONFIG_DIR: home };
  await mkdir(path.join(root, '.oasis'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo hi' } }));
  let settings = await loadSettings(root, { env });
  assert.equal(settings.statusLine, null);
  assert.equal(settings.ignoredUntrusted.length, 1);
  await setWorkspaceTrust(root, true, env);
  settings = await loadSettings(root, { env });
  assert.deepEqual(settings.statusLine, { type: 'command', command: 'echo hi' });
});
