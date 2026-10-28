// Customizable keyboard shortcuts in Claude Code's keybindings.json format.
//
// Files (later ones win): ~/.claude/keybindings.json, then <oasis config>/keybindings.json.
//   { "bindings": [ { "context": "Chat", "bindings": { "ctrl+e": "chat:externalEditor", "ctrl+s": null } } ] }
// Contexts used by OASIS: Global, Chat, Autocomplete, HistorySearch, and Confirmation/Select
// for permission dialogs.
// Keystrokes: modifiers ctrl/control, shift, alt/opt/option/meta, cmd/command/super/win;
// special keys escape/esc, enter/return, tab, space, up/down/left/right, pageup/pagedown,
// home/end, backspace/delete. Chords are space separated ("ctrl+x ctrl+e", 3 s between keys).
// "null" unbinds. Ctrl+C, Ctrl+D, Ctrl+M, Ctrl+[, Ctrl+I and Ctrl+H cannot be rebound.

import os from 'node:os';
import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { getConfigDirectory } from './config.mjs';

export const CHORD_TIMEOUT_MS = 3000;
export const RESERVED = new Set(['ctrl+c', 'ctrl+d', 'ctrl+m', 'ctrl+[', 'ctrl+i', 'ctrl+h']);
export const CONTEXTS = ['Global', 'Chat', 'Autocomplete', 'HistorySearch', 'Confirmation', 'Transcript', 'Task', 'Settings', 'Tabs', 'Help', 'ThemePicker', 'Attachments', 'Footer', 'MessageSelector', 'DiffDialog', 'DiffPanel', 'ModelPicker', 'EffortSlider', 'Select', 'Plugin', 'AbovePrompt', 'AbovePromptInput', 'AbovePromptSelect', 'Pane', 'PaneField', 'Agents', 'Scroll'];

// Claude Code's defaults for the contexts OASIS implements.
export const DEFAULT_BINDINGS = {
  Global: { 'ctrl+c': 'app:interrupt', 'ctrl+d': 'app:exit', 'ctrl+t': 'app:toggleTodos', 'ctrl+o': 'app:toggleTranscript' },
  Chat: {
    escape: 'chat:cancel', 'ctrl+l': 'chat:clearInput', 'shift+tab': 'chat:cycleMode', enter: 'chat:submit',
    'ctrl+j': 'chat:newline', 'shift+enter': 'chat:newline', 'meta+enter': 'chat:newline',
    'ctrl+_': 'chat:undo', 'ctrl+g': 'chat:externalEditor', 'ctrl+x ctrl+e': 'chat:externalEditor', 'ctrl+s': 'chat:stash',
    'ctrl+v': 'chat:imagePaste', 'meta+p': 'chat:modelPicker',
    'ctrl+r': 'history:search', up: 'history:previous', down: 'history:next'
  },
  Autocomplete: { tab: 'autocomplete:accept', escape: 'autocomplete:dismiss' },
  // OASIS keeps Enter = accept into the prompt and Esc = cancel; bind historySearch:execute to Enter for Claude Code's behavior.
  HistorySearch: { 'ctrl+r': 'historySearch:next', tab: 'historySearch:accept', 'ctrl+c': 'historySearch:cancel' },
  // Permission dialogs (Claude Code's Confirmation context, falling back to Select).
  Confirmation: { y: 'confirm:yes', n: 'confirm:no', escape: 'confirm:no', a: 'confirm:always', up: 'confirm:previous', down: 'confirm:next' },
  Select: { down: 'select:next', j: 'select:next', 'ctrl+n': 'select:next', up: 'select:previous', k: 'select:previous', 'ctrl+p': 'select:previous', enter: 'select:accept', escape: 'select:cancel' }
};

// What each action does in the OASIS editor: a key name for applyKey, or an editor action.
export const ACTIONS = {
  'app:interrupt': { key: 'ctrlC' }, 'app:exit': { key: 'ctrlD' }, 'app:toggleTodos': { key: 'ctrlT' }, 'app:toggleTranscript': { key: 'ctrlO' }, 'app:redraw': { action: 'redraw' },
  'history:search': { key: 'search' }, 'history:previous': { key: 'up' }, 'history:next': { key: 'down' },
  'chat:cancel': { key: 'escape' }, 'chat:clearInput': { key: 'clearScreen' }, 'chat:clearScreen': { key: 'clearScreen' }, 'chat:cycleMode': { key: 'shiftTab' },
  'chat:submit': { key: 'enter' }, 'chat:queueSubmit': { key: 'enter' }, 'chat:sendNow': { key: 'enter' }, 'chat:newline': { key: 'newline' }, 'chat:undo': { key: 'undo' },
  'chat:externalEditor': { action: 'externalEditor' }, 'chat:stash': { action: 'stash' }, 'chat:imagePaste': { key: 'ctrlV' },
  'chat:modelPicker': { command: 'model' },
  'autocomplete:accept': { key: 'tab' }, 'autocomplete:dismiss': { key: 'escape' },
  'confirm:yes': { dialog: 'yes' }, 'confirm:no': { dialog: 'no' }, 'confirm:always': { dialog: 'always' }, 'confirm:previous': { dialog: 'previous' }, 'confirm:next': { dialog: 'next' },
  'select:next': { dialog: 'next' }, 'select:previous': { dialog: 'previous' }, 'select:accept': { dialog: 'accept' }, 'select:cancel': { dialog: 'no' },
  'historySearch:next': { key: 'search' }, 'historySearch:accept': { key: 'searchAccept' }, 'historySearch:cancel': { key: 'ctrlG' }, 'historySearch:execute': { key: 'searchExecute' }
};

const MODIFIER_ALIASES = { ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'meta', opt: 'meta', option: 'meta', meta: 'meta', cmd: 'super', command: 'super', super: 'super', win: 'super' };
const KEY_ALIASES = { esc: 'escape', return: 'enter', ' ': 'space', del: 'delete', pgup: 'pageup', pgdn: 'pagedown' };
const MODIFIER_ORDER = ['ctrl', 'meta', 'shift', 'super'];

/** Normalizes one keystroke ("Ctrl+Shift+K" -> "ctrl+shift+k"). Returns null if malformed. */
export function normalizeStroke(text) {
  const original = String(text || '').trim();
  // A bare uppercase letter means Shift+letter; with modifiers, letters are case-insensitive.
  if (/^[A-Z]$/.test(original)) return 'shift+' + original.toLowerCase();
  const raw = original.toLowerCase();
  if (!raw) return null;
  const parts = raw === '+' ? ['+'] : raw.split('+').filter((part, index, all) => part !== '' || index === all.length - 1);
  if (raw.endsWith('++')) parts.splice(parts.length - 1, 1, '+');
  const key = KEY_ALIASES[parts[parts.length - 1]] || parts[parts.length - 1];
  if (!key) return null;
  const mods = new Set();
  for (const part of parts.slice(0, -1)) {
    const mod = MODIFIER_ALIASES[part];
    if (!mod) return null;
    mods.add(mod);
  }
  return [...MODIFIER_ORDER.filter((mod) => mods.has(mod)), key].join('+');
}

export function normalizeChord(text) {
  const strokes = String(text || '').trim().split(/\s+/).map(normalizeStroke);
  return strokes.length && strokes.every(Boolean) ? strokes.join(' ') : null;
}

function claudeHome(env) { return env.CLAUDE_CONFIG_DIR || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.claude'); }
export function keybindingFiles(env = process.env) {
  return [path.join(claudeHome(env), 'keybindings.json'), path.join(getConfigDirectory(env), 'keybindings.json')];
}

const cache = new Map();
function readBindingsFile(file) {
  let info;
  try { info = statSync(file); } catch { return null; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.value;
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { value = { error: 'not valid JSON (' + error.message + ')' }; }
  cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, value });
  return value;
}

/**
 * Effective bindings: { contexts: { Chat: Map(chord -> action|null), ... }, warnings, files }.
 * Re-read on every call (cached by mtime), so edits apply at the next prompt.
 */
export function loadKeybindings(env = process.env) {
  const contexts = {};
  for (const [context, map] of Object.entries(DEFAULT_BINDINGS)) contexts[context] = new Map(Object.entries(map));
  const warnings = [];
  const files = [];
  for (const file of keybindingFiles(env)) {
    const data = readBindingsFile(file);
    if (!data) continue;
    files.push(file);
    if (data.error) { warnings.push(file + ': ' + data.error); continue; }
    if (!Array.isArray(data.bindings)) { warnings.push(file + ': expected a "bindings" array.'); continue; }
    for (const block of data.bindings) {
      if (!block || typeof block !== 'object' || typeof block.context !== 'string') { warnings.push(file + ': each block needs a "context".'); continue; }
      if (!CONTEXTS.includes(block.context)) { warnings.push(file + ': unknown context "' + block.context + '".'); continue; }
      const target = contexts[block.context] ||= new Map();
      for (const [keys, action] of Object.entries(block.bindings || {})) {
        const chord = normalizeChord(keys);
        if (!chord) { warnings.push(file + ': cannot parse keystroke "' + keys + '".'); continue; }
        if (RESERVED.has(chord)) { warnings.push(file + ': ' + keys + ' is reserved and cannot be rebound.'); continue; }
        if (action !== null && typeof action !== 'string') { warnings.push(file + ': ' + keys + ' must map to an action name or null.'); continue; }
        if (typeof action === 'string' && !ACTIONS[action] && !/^command:[\w:.-]+$/.test(action) && !/^[a-zA-Z]+:[a-zA-Z]+$/.test(action)) { warnings.push(file + ': unknown action "' + action + '".'); continue; }
        target.set(chord, action);
      }
    }
  }
  return { contexts, warnings, files };
}

/** Context order for a lookup: the active context first, then Global. */
function chain(context) {
  if (context === 'HistorySearch') return ['HistorySearch', 'Global'];
  if (context === 'Autocomplete') return ['Autocomplete', 'Chat', 'Global'];
  if (context === 'Confirmation') return ['Confirmation', 'Select', 'Global'];
  if (context === 'Select') return ['Select', 'Global'];
  return ['Chat', 'Global'];
}

/**
 * Looks a keystroke sequence up. Returns
 *   { action }        bound (action may be a string)
 *   { unbound: true } explicitly set to null
 *   { prefix: true }  start of a chord: wait for the next key
 *   null              not bound: use the editor's built-in handling
 */
export function resolveBinding(bindings, context, sequence) {
  for (const name of chain(context)) {
    const map = bindings.contexts[name];
    if (!map) continue;
    if (map.has(sequence)) {
      const action = map.get(sequence);
      if (action === null) {
        // Unbound here; an outer context may still bind it.
        continue;
      }
      return { action };
    }
  }
  for (const name of chain(context)) {
    const map = bindings.contexts[name];
    if (!map) continue;
    for (const [chord, action] of map) if (action !== null && chord.startsWith(sequence + ' ')) return { prefix: true };
  }
  for (const name of chain(context)) {
    const map = bindings.contexts[name];
    if (map && map.has(sequence) && map.get(sequence) === null) return { unbound: true };
  }
  return null;
}

/** Describe an action as an editor operation. */
export function actionEffect(action) {
  if (typeof action !== 'string') return null;
  if (action.startsWith('command:')) return { command: action.slice('command:'.length) };
  return ACTIONS[action] || null;
}

const TEMPLATE = {
  $schema: 'https://www.schemastore.org/claude-code-keybindings.json',
  $docs: 'https://code.claude.com/docs/en/keybindings',
  bindings: [
    { context: 'Chat', bindings: { 'ctrl+e': 'chat:externalEditor', 'ctrl+x ctrl+c': 'command:compact' } }
  ]
};

/** Creates <oasis config>/keybindings.json with an example if missing; returns its path. */
export async function ensureKeybindingsFile(env = process.env) {
  const file = keybindingFiles(env)[1];
  try { await access(file); return { file, created: false }; } catch {}
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(TEMPLATE, null, 2) + '\n', 'utf8');
  return { file, created: true };
}

/** Lines for /keybindings: custom bindings in effect and any problems. */
export function describeKeybindings(env = process.env) {
  const bindings = loadKeybindings(env);
  const lines = [];
  for (const [context, map] of Object.entries(bindings.contexts)) {
    const defaults = DEFAULT_BINDINGS[context] || {};
    const custom = [...map].filter(([chord, action]) => defaults[chord] !== action);
    for (const [chord, action] of custom) lines.push('  ' + context.padEnd(14) + chord.padEnd(18) + (action === null ? '(unbound)' : action));
  }
  return { lines, warnings: bindings.warnings, files: bindings.files };
}
