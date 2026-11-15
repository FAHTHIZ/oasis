// `oasis -r` / bare `/resume` in a terminal printed a numbered list and asked
// the user to type /resume NUMBER. It now opens the same arrow-key picker as
// /model and /rewind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveSession } from '../src/sessions.mjs';
import { pickerFor } from '../src/select-dialog.mjs';

test('pickerFor("resume") lists saved chats newest first, with a cancel option', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-resume-picker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: path.join(dir, '.config'), OASIS_HOME: path.join(dir, '.oasis') };
  assert.equal(await pickerFor('resume', { root: dir, env }), null, 'no saved chats: fall back to the plain reply');
  const first = await saveSession({ root: dir, config: { model: 'm1' }, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'first task' }] }, { env });
  await new Promise((resolve) => setTimeout(resolve, 15));
  const second = await saveSession({ root: dir, config: { model: 'm2' }, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'second task' }] }, { env });
  const picker = await pickerFor('resume', { root: dir, env });
  const ids = (value) => value && (value.id || value.sessionId || value);
  assert.deepEqual(picker.options.slice(0, 2).map((option) => option.value), [ids(second), ids(first)]);
  assert.match(picker.options[0].label, /second task {2}\[m2\]/);
  assert.equal(picker.options.at(-1).value, null);
  assert.equal(await pickerFor('resume', { env }), null, 'needs the workspace root');
});

test('the terminal opens the picker for a bare /resume', async () => {
  const cli = await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.mjs'), 'utf8');
  assert.match(cli, /\['model', 'theme', 'color', 'rewind', 'presets', 'resume'\]\.includes/);
  assert.match(cli, /'Resume which chat\?\\n'/);
});
