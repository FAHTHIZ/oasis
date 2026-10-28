// /config settings pane (Claude Code's /config "Settings" tab). Each item reads its current value
// and applies a new one: it saves to user settings (~/.oasis/settings.json) and updates the live
// session, reusing the matching slash command where one exists (/theme, /model, /vim, ...).
//
//   /config                 interactive pane (TTY): pick a setting, then pick a value
//   /config list            every item with its current value
//   /config get KEY         one value
//   /config set KEY VALUE   change it (same keys as settings.json)
import { readFile } from 'node:fs/promises';
import { updateUserSettings, userSettingsPath } from './settings.mjs';

async function userSettings(env) {
  try { return JSON.parse(await readFile(userSettingsPath(env), 'utf8')); } catch { return {}; }
}

function getPath(object, key) {
  return key.split('.').reduce((value, part) => (value && typeof value === 'object' ? value[part] : undefined), object);
}

async function saveSetting(key, value, env) {
  await updateUserSettings((settings) => {
    const parts = key.split('.');
    let target = settings;
    for (const part of parts.slice(0, -1)) { if (!target[part] || typeof target[part] !== 'object') target[part] = {}; target = target[part]; }
    if (value === undefined) delete target[parts.at(-1)]; else target[parts.at(-1)] = value;
    return settings;
  }, env);
}

const BOOL = ['true', 'false'];

/** The settings shown in the pane. `choices` may be async; `apply` returns a message. */
export function configItems() {
  return [
    {
      key: 'theme', label: 'Theme', description: 'Color theme (also /theme)',
      choices: async (state) => (await import('./themes.mjs')).listThemes({ env: state.env, plugins: (state.session && state.session.settings && state.session.settings.pluginThemeSources) || [] }).map((theme) => theme.id),
      current: async (state, saved) => saved.theme || 'dark',
      apply: async (value, state, run) => (await run('theme', value)).output
    },
    {
      key: 'model', label: 'Model', description: 'Default model for new sessions (also /model)',
      choices: async () => (await import('./model-aliases.mjs')).MODEL_ALIASES,
      current: async (state, saved) => (state.session && state.session.config && state.session.config.model) || saved.model || '(provider default)',
      apply: async (value, state, run) => { await saveSetting('model', value, state.env); return (state.session ? (await run('model', value)).output + ' ' : '') + 'Saved as the default model.'; }
    },
    {
      key: 'permissions.defaultMode', label: 'Default permission mode', description: 'Mode new sessions start in',
      choices: async () => ['default', 'acceptEdits', 'plan', 'auto'],
      current: async (state, saved) => getPath(saved, 'permissions.defaultMode') || 'default',
      apply: async (value, state, run) => { await saveSetting('permissions.defaultMode', value, state.env); if (state.session) await run('mode', value); return 'Default permission mode set to ' + value + '.'; }
    },
    {
      key: 'editorMode', label: 'Editor mode', description: 'Prompt key bindings (also /vim)',
      choices: async () => ['normal', 'vim'],
      current: async (state, saved) => (state.sessionOptions && state.sessionOptions.editorMode) || saved.editorMode || 'normal',
      apply: async (value, state, run) => (await run('vim', value === 'vim' ? 'on' : 'off')).output
    },
    {
      key: 'outputStyle', label: 'Output style', description: 'How replies are written (also /output-style)',
      choices: async (state) => Object.keys(await (await import('./output-styles.mjs')).loadOutputStyles(state.root, { env: state.env })),
      current: async (state, saved) => (state.session && state.session.outputStyle) || saved.outputStyle || 'default',
      apply: async (value, state, run) => { await saveSetting('outputStyle', value === 'default' ? undefined : value, state.env); const shown = (await run('output-style', value)).output; return shown + ' Saved as the default.'; }
    },
    {
      key: 'verbose', label: 'Verbose output', description: 'Show full tool output (commands, reads) in the transcript',
      choices: async () => BOOL,
      current: async (state, saved) => String(Boolean((state.sessionOptions && state.sessionOptions.verbose) ?? saved.verbose)),
      apply: async (value, state) => { const on = value === 'true'; await saveSetting('verbose', on, state.env); if (state.sessionOptions) state.sessionOptions.verbose = on; return 'Verbose output ' + (on ? 'on' : 'off') + '.'; }
    },
    {
      key: 'autoCompactEnabled', label: 'Auto-compact', description: 'Compact the conversation automatically when the context fills up',
      choices: async () => BOOL,
      current: async (state, saved) => String(saved.autoCompactEnabled !== false),
      apply: async (value, state) => {
        const on = value === 'true';
        await saveSetting('autoCompactEnabled', on ? undefined : false, state.env);
        if (state.session && state.session.config) { if (on) delete state.session.config.autoCompactPercent; else state.session.config.autoCompactPercent = 0; }
        return 'Auto-compact ' + (on ? 'on' : 'off') + '.';
      }
    },
    {
      key: 'autoMemory', label: 'Auto memory', description: 'Let Oasis save and recall project memories',
      choices: async () => BOOL,
      current: async (state, saved) => String(saved.autoMemory !== false),
      apply: async (value, state) => { await saveSetting('autoMemory', value === 'true', state.env); return 'Auto memory ' + (value === 'true' ? 'on' : 'off') + ' (applies to new sessions).'; }
    },
    {
      key: 'chrome', label: 'Chrome browser tool', description: 'Give the agent a browser (also /chrome)',
      choices: async () => BOOL,
      current: async (state, saved) => String(Boolean(state.session ? state.session.chromeEnabled : saved.chrome)),
      apply: async (value, state, run) => { await saveSetting('chrome', value === 'true', state.env); if (state.session) await run('chrome', value === 'true' ? 'on' : 'off'); return 'Chrome browser tool ' + (value === 'true' ? 'on' : 'off') + '.'; }
    },
    {
      key: 'defaultShell', label: 'Shell for ! commands', description: 'bash or powershell',
      choices: async () => ['bash', 'powershell'],
      current: async (state, saved) => saved.defaultShell || 'bash',
      apply: async (value, state) => { await saveSetting('defaultShell', value, state.env); return 'Shell for ! commands set to ' + value + '.'; }
    },
    {
      key: 'channelsEnabled', label: 'Channels', description: 'Allow MCP channel messages into the session',
      choices: async () => BOOL,
      current: async (state, saved) => String(saved.channelsEnabled !== false),
      apply: async (value, state) => { await saveSetting('channelsEnabled', value === 'true' ? undefined : false, state.env); return 'Channels ' + (value === 'true' ? 'allowed' : 'disabled') + ' (applies to new sessions).'; }
    }
  ];
}

export function findConfigItem(key) {
  const wanted = String(key || '').trim().toLowerCase();
  return configItems().find((item) => item.key.toLowerCase() === wanted || item.label.toLowerCase() === wanted || item.key.split('.').at(-1).toLowerCase() === wanted) || null;
}

export async function configRows(state) {
  const saved = await userSettings(state.env);
  const rows = [];
  for (const item of configItems()) rows.push({ item, value: String(await item.current(state, saved)) });
  return rows;
}

export async function describeConfig(state) {
  const rows = await configRows(state);
  const width = Math.max(...rows.map((row) => row.item.label.length));
  return 'Settings (saved to ' + userSettingsPath(state.env) + '):\n' + rows.map((row) => '  ' + row.item.label.padEnd(width) + '  ' + row.value.padEnd(14) + ' ' + row.item.key).join('\n') + '\nChange one with /config set KEY VALUE, or run /config in a terminal for the interactive pane. /status shows where each setting comes from.';
}

/** Applies KEY=VALUE through the item's handler. `run(name, arg)` runs a built-in slash command. */
export async function setConfigValue(key, value, state, run) {
  const item = findConfigItem(key);
  if (!item) throw new Error('Unknown setting ' + key + '. Settings: ' + configItems().map((entry) => entry.key).join(', ') + '.');
  let wanted = String(value ?? '').trim();
  if (/^(on|yes|enable|enabled)$/i.test(wanted)) wanted = 'true';
  if (/^(off|no|disable|disabled)$/i.test(wanted)) wanted = 'false';
  const choices = await item.choices(state);
  const isOpen = item.key === 'model';
  if (!isOpen && !choices.includes(wanted)) throw new Error(item.label + ' must be one of: ' + choices.join(', ') + '.');
  if (!wanted) throw new Error('Give a value for ' + item.key + '.');
  return item.apply(wanted, state, run);
}
