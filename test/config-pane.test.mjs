import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import '../src/tools.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { configItems, findConfigItem, setConfigValue, describeConfig } from '../src/config-pane.mjs';
import { verboseToolOutput } from '../src/terminal-ui.mjs';
import { createSession, closeSession } from '../src/agent.mjs';
import { loadSettings } from '../src/settings.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

async function setup() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-config-home-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-config-root-'));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_IGNORE_CLAUDE_SETTINGS: '1', OASIS_DISABLE_THEME_RELOAD: '1' };
  await mkdir(path.join(home, 'cfg'), { recursive: true });
  return { home, root, env, file: path.join(home, 'cfg', 'settings.json') };
}

test('/config list, get and set write user settings', async () => {
  const { root, env, file } = await setup();
  const state = { root, env, sessionOptions: {} };
  assert.match((await runBuiltinCommand('config', 'list', state)).output, /Verbose output/);
  assert.match((await runBuiltinCommand('config', 'set verbose on', state)).output, /Verbose output on/);
  assert.equal(state.sessionOptions.verbose, true);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).verbose, true);
  assert.equal((await runBuiltinCommand('config', 'get verbose', state)).output, 'verbose = true');
  await runBuiltinCommand('config', 'set permissions.defaultMode plan', state);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).permissions.defaultMode, 'plan');
  await runBuiltinCommand('config', 'set autoCompactEnabled false', state);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).autoCompactEnabled, false);
  assert.match((await runBuiltinCommand('config', 'set defaultShell zsh', state)).output, /must be one of/);
  assert.match((await runBuiltinCommand('config', 'set nope 1', state)).output, /Unknown setting/);
  await runBuiltinCommand('config', 'editorMode vim', state);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).editorMode, 'vim');
  assert.ok(findConfigItem('Theme'));
  assert.ok(configItems().length >= 10);
  assert.match(await describeConfig(state), /permissions\.defaultMode/);
});

test('autoCompactEnabled false turns off compaction for new sessions; verbose loads from settings', async (t) => {
  const { root, env, file } = await setup();
  await writeFile(file, JSON.stringify({ autoCompactEnabled: false, verbose: true }));
  const loaded = await loadSettings(root, { env });
  assert.equal(loaded.verbose, true);
  const { config } = await scriptedModel(t, [{ content: 'ok' }]);
  const session = await createSession({ root, config, env, settings: loaded });
  assert.equal(session.config.autoCompactPercent, 0);
  closeSession(session);
});

test('setConfigValue for output style updates the live session', async (t) => {
  const { root, env, file } = await setup();
  const { config } = await scriptedModel(t, [{ content: 'ok' }]);
  const session = await createSession({ root, config, env, settings: { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } } });
  const state = { root, env, session, sessionOptions: {} };
  const message = await setConfigValue('outputStyle', 'explanatory', state, (name, arg) => runBuiltinCommand(name, arg, state));
  assert.match(message, /explanatory/);
  assert.equal(session.outputStyle, 'explanatory');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).outputStyle, 'explanatory');
  closeSession(session);
});

test('verbose tool output shows stdout/stderr and caps long output', () => {
  assert.match(verboseToolOutput('run_command', { stdout: 'hello\nworld', stderr: 'warn', exitCode: 0 }), /⎿ hello\n {2}⎿ world\n {2}⎿ \[stderr\]/);
  const long = verboseToolOutput('read_file', { content: Array.from({ length: 10 }, (_, i) => 'line' + i).join('\n') }, { maxLines: 3 });
  assert.match(long, /7 more lines/);
  assert.equal(verboseToolOutput('x', null), '');
});
