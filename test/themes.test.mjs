import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { parseColor, resolveTheme, listThemes, applyTheme, detectBackground, themePreference, currentTheme } from '../src/themes.mjs';
import { ANSI, renderDiff } from '../src/markdown.mjs';
import { footerFor, describeTool } from '../src/terminal-ui.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';

async function home(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-themes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), OASIS_CONFIG_DIR: path.join(dir, '.config', 'oasis') };
  return { dir, env };
}

test('color values follow Claude Code syntax; invalid ones are rejected', () => {
  assert.equal(parseColor('#bd93f9').fg, '\x1b[38;2;189;147;249m');
  assert.equal(parseColor('#fff').bg, '\x1b[48;2;255;255;255m');
  assert.equal(parseColor('rgb(1, 2, 3)').fg, '\x1b[38;2;1;2;3m');
  assert.equal(parseColor('ansi256(22)').bg, '\x1b[48;5;22m');
  assert.equal(parseColor('ansi:red').fg, '\x1b[31m');
  assert.equal(parseColor('ansi:cyanBright').fg, '\x1b[96m');
  for (const bad of ['#12', 'rgb(300,0,0)', 'ansi256(999)', 'ansi:purple', 'blue']) assert.equal(parseColor(bad), null, bad);
  assert.equal(detectBackground({ COLORFGBG: '0;15' }), 'light');
  assert.equal(detectBackground({ COLORFGBG: '15;0' }), 'dark');
  assert.equal(detectBackground({}), 'dark');
});

test('custom and plugin themes override tokens on top of a base preset', async (t) => {
  const { dir, env } = await home(t);
  await mkdir(path.join(env.CLAUDE_CONFIG_DIR, 'themes'), { recursive: true });
  await writeFile(path.join(env.CLAUDE_CONFIG_DIR, 'themes', 'dracula.json'), JSON.stringify({ name: 'Dracula', base: 'dark', overrides: { claude: '#bd93f9', error: '#ff5555', success: '#50fa7b', bogus: '#000', planMode: 'nope' } }));
  const plugin = path.join(dir, 'plug');
  await mkdir(path.join(plugin, 'themes'), { recursive: true });
  await writeFile(path.join(plugin, 'themes', 'sunset.json'), JSON.stringify({ base: 'light', overrides: { diffAdded: '#ccffcc' } }));
  const plugins = [{ name: 'plug', root: plugin, manifest: {} }];
  const ids = listThemes({ env, plugins }).map((theme) => theme.id);
  assert.ok(ids.includes('custom:dracula') && ids.includes('plugin:plug:sunset') && ids.includes('light-ansi') && ids.includes('auto'));
  const dracula = resolveTheme('custom:dracula', { env, plugins });
  assert.equal(dracula.name, 'Dracula');
  assert.equal(dracula.colors.error.fg, '\x1b[38;2;255;85;85m');
  assert.equal(dracula.colors.planMode.fg, '\x1b[36m', 'invalid values fall through to the base');
  const sunset = resolveTheme('plugin:plug:sunset', { env, plugins });
  assert.equal(sunset.base, 'light');
  assert.equal(sunset.colors.diffAdded.bg, '\x1b[48;2;204;255;204m');
  assert.equal(resolveTheme('custom:missing', { env }).id, 'dark');
  assert.equal(resolveTheme('auto', { env: { ...env, COLORFGBG: '0;15' } }).id, 'light');

  try {
    applyTheme(dracula);
    assert.equal(ANSI.red, '\x1b[38;2;255;85;85m');
    assert.match(renderDiff('a\n', 'b\n').text, /\x1b\[38;2;80;250;123m\+ b/);
    assert.match(describeTool({ name: 'read_file', args: { path: 'x' } }), /^\x1b\[38;2;189;147;249m⏺/);
    applyTheme(resolveTheme('dark-ansi', { env }));
    assert.ok(!renderDiff('a\n', 'b\n').text.includes('\x1b[48;'), 'ANSI themes paint no 256/truecolor backgrounds');
    applyTheme(resolveTheme('light', { env }));
    assert.match(footerFor({ mode: 'plan' }), /^\x1b\[38;2;14;116;144m/);
  } finally { applyTheme(resolveTheme('dark', { env: {} })); }
  assert.equal(ANSI.red, '\x1b[31m', 'dark restores the default palette');
});

test('/theme lists themes, switches and saves the preference', async (t) => {
  const { env } = await home(t);
  try {
    const listed = await runBuiltinCommand('theme', '', { root: process.cwd(), env });
    assert.match(listed.output, /dark-daltonized/);
    const set = await runBuiltinCommand('theme', 'light-daltonized', { root: process.cwd(), env });
    assert.match(set.output, /Theme set to light-daltonized/);
    assert.equal(currentTheme().id, 'light-daltonized');
    const saved = JSON.parse(await readFile(path.join(env.OASIS_CONFIG_DIR, 'settings.json'), 'utf8'));
    assert.equal(saved.theme, 'light-daltonized');
    assert.match((await runBuiltinCommand('theme', 'neon', { root: process.cwd(), env })).output, /Unknown theme/);
    assert.equal(themePreference({ env, settings: { theme: 'light' } }), 'light');
    assert.equal(themePreference({ env: { ...env, OASIS_THEME: 'dark-ansi' }, settings: { theme: 'light' } }), 'dark-ansi');
    await writeFile(path.join(env.HOME, '.claude.json'), JSON.stringify({ theme: 'light-ansi' }));
    assert.equal(themePreference({ env, settings: null }), 'light-ansi', "Claude Code's ~/.claude.json theme is honored");
  } finally { applyTheme(resolveTheme('dark', { env: {} })); }
});

test('plugin validate checks theme files', async (t) => {
  const { dir } = await home(t);
  const { validatePath } = await import('../src/claude-plugins.mjs');
  const plugin = path.join(dir, 'tp');
  await mkdir(path.join(plugin, '.claude-plugin'), { recursive: true });
  await mkdir(path.join(plugin, 'themes'), { recursive: true });
  await writeFile(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'tp' }));
  await writeFile(path.join(plugin, 'themes', 'ok.json'), JSON.stringify({ base: 'light', overrides: { claude: '#123456', rainbow_red: '#ff0000' } }));
  assert.equal((await validatePath(plugin)).problems.length, 0);
  await writeFile(path.join(plugin, 'themes', 'bad.json'), JSON.stringify({ base: 'solarized', overrides: { claude: 'purple', nope: '#000' } }));
  const problems = (await validatePath(plugin)).problems.join('\n');
  assert.match(problems, /unknown base "solarized"/);
  assert.match(problems, /invalid color for claude/);
  assert.match(problems, /unknown token "nope"/);
});
