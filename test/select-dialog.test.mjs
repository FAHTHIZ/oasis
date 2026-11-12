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
