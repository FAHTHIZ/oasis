import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { selectDialog } from '../src/select-dialog.mjs';

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
function tty() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  let rendered = '';
  output.on('data', (chunk) => { rendered += chunk; });
  return { input, output, rendered: () => rendered };
}
function envWith(bindings) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'oasis-dialog-'));
  const cfg = path.join(home, 'cfg');
  mkdirSync(cfg, { recursive: true });
  if (bindings) writeFileSync(path.join(cfg, 'keybindings.json'), JSON.stringify({ bindings }));
  return { HOME: home, OASIS_CONFIG_DIR: cfg };
}
const OPTIONS = [{ label: 'Yes', value: true, hotkey: 'yes' }, { label: 'Always', value: 'always', hotkey: 'always' }, { label: 'No', value: false, hotkey: 'no' }];

async function pick(keys, env = envWith()) {
  const t = tty();
  const done = selectDialog({ input: t.input, output: t.output, options: OPTIONS, env, color: false });
  for (const key of keys) { await tick(); t.input.write(key); }
  return { value: await done, rendered: t.rendered() };
}

test('arrow keys, j/k and Enter choose an option', async () => {
  assert.equal((await pick(['\r'])).value, true);
  assert.equal((await pick(['\x1b[B', '\r'])).value, 'always');
  assert.equal((await pick(['j', 'j', 'k', '\r'])).value, 'always');
  assert.equal((await pick(['\x1b[A', '\r'])).value, false);
  const shown = (await pick(['\r'])).rendered;
  assert.match(shown, /❯ 1\. Yes/);
  assert.match(shown, /→ Yes/);
});

test('digits, y/n/a hotkeys, Esc and Ctrl+C answer directly', async () => {
  assert.equal((await pick(['2'])).value, 'always');
  assert.equal((await pick(['y'])).value, true);
  assert.equal((await pick(['a'])).value, 'always');
  assert.equal((await pick(['n'])).value, false);
  assert.equal((await pick(['\x1b'])).value, false);
  assert.equal((await pick(['\x03'])).value, false);
});

test('the Confirmation context can be rebound and aborts decline', async () => {
  const env = envWith([{ context: 'Confirmation', bindings: { y: null, 'ctrl+y': 'confirm:yes' } }]);
  assert.equal((await pick(['y', '\x19'], env)).value, true);
  const controller = new AbortController();
  const t = tty();
  const done = selectDialog({ input: t.input, output: t.output, options: OPTIONS, env: envWith(), color: false, signal: controller.signal });
  controller.abort();
  assert.equal(await done, false);
});

test('pickers list models (respecting availableModels), themes and colors', async () => {
  const { pickerFor } = await import('../src/select-dialog.mjs');
  const session = { config: { model: 'sonnet', protocol: 'anthropic' }, availableModels: ['sonnet', 'haiku'] };
  const model = await pickerFor('model', { session, env: {} });
  assert.equal(model.context, 'ModelPicker');
  const values = model.options.map((o) => o.value);
  assert.ok(values.includes('sonnet') && values.includes('haiku') && values.includes('default'));
  assert.ok(!values.includes('opus'));
  assert.equal(model.options[model.initial].value, 'sonnet');
  assert.equal(values.at(-1), null);
  const theme = await pickerFor('theme', { env: envWith() });
  assert.ok(theme.options.some((o) => o.value === 'light-daltonized'));
  const color = await pickerFor('color', {});
  assert.ok(color.options.some((o) => o.value === 'purple'));
  assert.equal(await pickerFor('cost', {}), null);
});

test('rewind pickers offer turns and what to restore', async () => {
  const { pickerFor } = await import('../src/select-dialog.mjs');
  assert.equal(await pickerFor('rewind', { session: null }), null);
  const modes = await pickerFor('rewind-mode');
  assert.deepEqual(modes.options.map((option) => option.value), ['', 'chat', 'code', null]);
});

test('an answered approval collapses to one summary line when it fits on screen', async () => {
  const run = async (rows, key = '2') => {
    const t = tty();
    t.output.rows = rows;
    const done = selectDialog({ input: t.input, output: t.output, options: OPTIONS, env: envWith(), color: false, collapse: { rows: 4, summary: (chosen) => '  ⎿ Picked ' + chosen.label } });
    await tick(); t.input.write(key);
    return { value: await done, rendered: t.rendered() };
  };
  const fits = await run(30);
  assert.equal(fits.value, 'always');
  // Up over 3 option rows and the 4 question rows, then clear below.
  assert.ok(fits.rendered.includes('\x1b[7A\x1b[J  ⎿ Picked Always'), JSON.stringify(fits.rendered.slice(-80)));
  assert.doesNotMatch(fits.rendered, /→ Always/);
  // Too tall for the screen: keep the old one-line answer instead of a broken redraw.
  const tall = await run(6);
  assert.match(tall.rendered, /→ Always/);
  assert.doesNotMatch(tall.rendered, /Picked/);
});

test('approval summaries and wrapped row counts', async () => {
  const { approvalRows, approvalSummary } = await import('../src/cli.mjs');
  assert.equal(approvalRows('\nOASIS wants to run this command:\n  npm test\nDo you want to proceed?', 80), 4);
  assert.equal(approvalRows('x'.repeat(81), 80), 2);
  assert.equal(approvalRows('\x1b[1mbold\x1b[22m', 80), 1);
  assert.equal(approvalSummary({ value: true }), '  ⎿ Allowed once');
  assert.equal(approvalSummary({ value: 'always' }, { suggestion: 'run_command(npm test:*)' }), '  ⎿ Allowed for this session: run_command(npm test:*)');
  assert.equal(approvalSummary({ value: false }), '  ⎿ Denied');
  assert.equal(approvalSummary(undefined), '  ⎿ Denied');
});

test('terminal approvals show the proposed diff, colored and capped', async () => {
  const { renderApprovalText } = await import('../src/cli.mjs');
  const { formatApprovalMessage } = await import('../src/approval-language.mjs');
  const approval = formatApprovalMessage('Review this edit.', { tool: 'edit_file', input: { path: 'a.js', old_string: 'one();', new_string: 'two();' } });
  const plain = renderApprovalText(approval, { color: false });
  assert.match(plain, /OASIS wants to change the file/);
  assert.match(plain, /^ {2}-one\(\);$/m);
  assert.match(plain, /^ {2}\+two\(\);$/m);
  const colored = renderApprovalText(approval, { color: true });
  assert.match(colored, /\x1b\[32m {2}\+two\(\);\x1b\[0m/);
  assert.match(colored, /\x1b\[31m {2}-one\(\);\x1b\[0m/);
  const long = formatApprovalMessage('Write it.', { tool: 'write_file', input: { path: 'b.txt', content: Array.from({ length: 50 }, (_, i) => 'line ' + i).join('\n') } });
  const capped = renderApprovalText(long, { color: false, maxDiffLines: 10 });
  assert.match(capped, /… \d+ more lines$/);
  assert.equal(capped.split('\n').filter((line) => line.startsWith('  +line')).length <= 10, true);
  const risky = formatApprovalMessage('Run this command in the workspace?\n  rm -rf build');
  assert.match(renderApprovalText(risky, { color: false }), /^WARNING — RISKY ACTION/, 'plain output keeps the warning text');
  assert.match(renderApprovalText(risky, { color: true }), /⚠ Risky action/);
  assert.match(renderApprovalText(risky, { color: true }), /\x1b\[36m {2}rm -rf build\x1b\[0m/);
});

test('long option labels are cut to one terminal row so redraws stay in place', async () => {
  const t = tty();
  t.output.columns = 20;
  const options = [{ label: '日本語のとても長いラベルです', value: 1 }, { label: 'short', value: 2 }];
  const done = selectDialog({ input: t.input, output: t.output, options, env: envWith(), color: false });
  await tick(); t.input.write('\x1b[B');
  await tick(); t.input.write('\r');
  assert.equal(await done, 2);
  const { default: stringWidth } = await import('string-width');
  const rows = t.rendered().split(/\r\n|\x1b\[\d+A\r/).filter((row) => row.includes('1. '));
  assert.ok(rows.length >= 2);
  for (const row of rows) { assert.ok(stringWidth(row) <= 19, row); assert.ok(row.endsWith('…'), row); }
});

// Seen live with OVH AI Endpoints: /model listed Whisper, text-to-speech,
// embedding, Stable Diffusion and guard models next to the chat models.
test('the /model picker leaves out models that cannot chat', async (t) => {
  const http = await import('node:http');
  const ids = ['Qwen3.5-397B-A17B', 'bge-m3', 'gpt-oss-120b', 'nvr-tts-en-us', 'Qwen3-Embedding-8B', 'Qwen3Guard-Gen-8B', 'stable-diffusion-xl-base-v10', 'whisper-large-v3', 'Qwen2.5-VL-72B-Instruct'];
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: ids.map((id) => ({ id })) })); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { pickerFor } = await import('../src/select-dialog.mjs');
  const { clearProviderModelCache, isLikelyChatModel } = await import('../src/provider-models.mjs');
  clearProviderModelCache();
  const session = { config: { model: 'Qwen3.5-397B-A17B', protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: '' }, root: process.cwd() };
  const values = (await pickerFor('model', { session, env: {} })).options.map((o) => o.value);
  assert.deepEqual(values, ['Qwen3.5-397B-A17B', 'gpt-oss-120b', 'Qwen2.5-VL-72B-Instruct', null]);
  for (const id of ['claude-sonnet-4-5', 'gemini-2.5-pro', 'deepseek-chat', 'codestral-latest', 'guardian-x', 'Qwen3-Coder-480B']) assert.equal(isLikelyChatModel(id), true, id);
  for (const id of ['text-embedding-3-small', 'mistral-embed', 'models/gemini-embedding-001', 'tts-1', 'gpt-4o-mini-tts', 'gpt-4o-transcribe', 'omni-moderation-latest', 'meta-llama/llama-guard-4-12b', 'dall-e-3']) assert.equal(isLikelyChatModel(id), false, id);
});
