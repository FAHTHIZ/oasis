import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBuiltinCommand, BUILTIN_COMMANDS, COMMAND_ALIASES } from '../src/slash.mjs';
import { loadPresets, parseSlot, presetsFile, lastUserMessage } from '../src/presets.mjs';
import { pickerFor } from '../src/select-dialog.mjs';

async function tempEnv(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oasis-presets-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { ...process.env, OASIS_HOME: dir, OASIS_CONFIG_DIR: dir, XDG_CONFIG_HOME: dir, HOME: dir };
}
const run = (argument, env, session = null) => runBuiltinCommand('presets', argument, { root: process.cwd(), env, session, sessionOptions: {} });

test('/presets is a built-in command with a /preset alias', () => {
  assert.ok(Object.hasOwn(BUILTIN_COMMANDS, 'presets'));
  assert.equal(COMMAND_ALIASES.preset, 'presets');
});

test('slots parse 1-10 and 0 as 10', () => {
  assert.equal(parseSlot('1'), 1);
  assert.equal(parseSlot('0'), 10);
  assert.equal(parseSlot('10'), 10);
  assert.equal(parseSlot('11'), 0);
  assert.equal(parseSlot('x'), 0);
});

test('save, list, run and clear presets', async (t) => {
  const env = await tempEnv(t);
  let result = await run('', env);
  assert.match(result.output, /0 of 10 saved/);
  result = await run('save 2 Run the tests and fix the first failure', env);
  assert.match(result.output, /Saved to preset 2/);
  result = await run('save 3 /review', env);
  const slots = await loadPresets(env);
  assert.equal(slots[1], 'Run the tests and fix the first failure');
  assert.equal(slots[2], '/review');
  assert.match((await run('list', env)).output, /2 of 10 saved[\s\S]*2  Run the tests/);
  result = await run('2', env);
  assert.equal(result.queue, 'Run the tests and fix the first failure');
  assert.equal((await run('3', env)).queue, '/review');
  assert.match((await run('4', env)).output, /Preset 4 is empty/);
  assert.equal((await run('4', env)).queue, undefined);
  assert.match((await run('clear 2', env)).output, /Cleared preset 2/);
  assert.equal((await loadPresets(env))[1], '');
  assert.match((await run('clear all', env)).output, /Cleared all/);
  assert.deepEqual((await loadPresets(env)).filter(Boolean), []);
  const stat = await fs.stat(presetsFile(env));
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o077, 0, 'presets.json is private');
});

test('save without text keeps the last message you sent', async (t) => {
  const env = await tempEnv(t);
  const session = { messages: [{ role: 'user', content: 'Add a --json flag to the CLI' }, { role: 'assistant', content: 'Done.' }, { role: 'user', content: '<system-reminder>checklist</system-reminder>' }] };
  assert.equal(lastUserMessage(session), 'Add a --json flag to the CLI');
  assert.match((await run('save 1', env, session)).output, /Saved to preset 1: Add a --json flag/);
  assert.match((await run('save 5', env, null)).output, /Nothing to save/);
});

test('a preset cannot run /presets (no loops)', async (t) => {
  const env = await tempEnv(t);
  assert.match((await run('save 1 /presets 1', env)).output, /cannot run another \/presets/);
  await fs.mkdir(path.dirname(presetsFile(env)), { recursive: true });
  await fs.writeFile(presetsFile(env), JSON.stringify({ slots: ['/preset 1'] }));
  const result = await run('1', env);
  assert.equal(result.queue, undefined);
  assert.match(result.output, /not sent/);
});

test('the terminal picker lists saved slots only', async (t) => {
  const env = await tempEnv(t);
  assert.equal(await pickerFor('presets', { env }), null);
  await run('save 7 Summarize what changed today', env);
  const picker = await pickerFor('presets', { env });
  assert.equal(picker.options[0].value, '7');
  assert.match(picker.options[0].label, /7  Summarize/);
  assert.equal(picker.options.at(-1).value, null);
});
