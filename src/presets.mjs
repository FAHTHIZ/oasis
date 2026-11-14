// Ten numbered slots for prompts and slash commands you send often, like the
// /presets slots in Codex. Stored per user in presets.json next to config.json,
// so they follow you across projects.
import fs from 'node:fs/promises';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';
import { replaceFileDurably } from './atomic-write.mjs';

const PRESET_SLOTS = 10;
const MAX_TEXT = 8000;

export function presetsFile(env = process.env) {
  return path.join(getConfigDirectory(env), 'presets.json');
}

// Slots 1..10 (10 is also typed as 0). Returns an array of 10 strings ('' for empty).
export async function loadPresets(env = process.env) {
  const slots = Array(PRESET_SLOTS).fill('');
  let raw;
  try { raw = JSON.parse(await fs.readFile(presetsFile(env), 'utf8')); } catch { return slots; }
  const list = raw && typeof raw === 'object' ? raw.slots || raw : null;
  if (Array.isArray(list)) list.slice(0, PRESET_SLOTS).forEach((text, index) => { if (typeof text === 'string') slots[index] = text.slice(0, MAX_TEXT); });
  else if (list && typeof list === 'object') for (const [key, text] of Object.entries(list)) {
    const slot = parseSlot(key);
    if (slot && typeof text === 'string') slots[slot - 1] = text.slice(0, MAX_TEXT);
  }
  return slots;
}

async function savePresets(slots, env) {
  const file = presetsFile(env);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await replaceFileDurably(file, JSON.stringify({ version: 1, slots }, null, 2) + '\n', { mode: 0o600 });
}

export function parseSlot(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,2}$/.test(text)) return 0;
  const number = Number(text) === 0 ? 10 : Number(text);
  return number >= 1 && number <= PRESET_SLOTS ? number : 0;
}

export async function setPreset(slot, text, env = process.env) {
  const number = parseSlot(slot);
  if (!number) throw new Error('Pick a slot from 1 to 10.');
  const value = String(text || '').trim();
  if (!value) throw new Error('Nothing to save. Give the prompt or /command to keep in slot ' + number + '.');
  if (/^\/presets?(\s|$)/i.test(value)) throw new Error('A preset cannot run another /presets command.');
  if (value.length > MAX_TEXT) throw new Error('A preset holds up to ' + MAX_TEXT + ' characters.');
  const slots = await loadPresets(env);
  slots[number - 1] = value;
  await savePresets(slots, env);
  return number;
}

async function clearPreset(slot, env = process.env) {
  const slots = await loadPresets(env);
  if (String(slot).trim().toLowerCase() === 'all') { await savePresets(Array(PRESET_SLOTS).fill(''), env); return 'all'; }
  const number = parseSlot(slot);
  if (!number) throw new Error('Pick a slot from 1 to 10, or all.');
  slots[number - 1] = '';
  await savePresets(slots, env);
  return number;
}

function oneLine(text, width = 70) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > width ? flat.slice(0, width - 1) + '…' : flat;
}

function formatPresets(slots) {
  const lines = ['Presets (' + slots.filter(Boolean).length + ' of ' + PRESET_SLOTS + ' saved):'];
  slots.forEach((text, index) => lines.push('  ' + String(index + 1).padStart(2) + '  ' + (text ? oneLine(text) : '(empty)')));
  lines.push('', '/presets N runs slot N · /presets save N TEXT (no TEXT saves your last message) · /presets clear N');
  return lines.join('\n');
}

// The last message the user typed in this conversation (not system reminders).
export function lastUserMessage(session) {
  const messages = session && Array.isArray(session.messages) ? session.messages : [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const item = messages[index];
    if (!item || item.role !== 'user' || typeof item.content !== 'string') continue;
    const text = item.content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
    if (text) return text;
  }
  return '';
}

// /presets [N | save N [TEXT] | clear N|all | list]
export async function presetsCommand(argument, { env = process.env, session = null } = {}) {
  const [verb = '', ...rest] = String(argument || '').trim().split(/\s+/).filter(Boolean);
  const lower = verb.toLowerCase();
  if (!verb || lower === 'list') return { output: formatPresets(await loadPresets(env)) };
  if (['save', 'set', 'add'].includes(lower)) {
    const slot = rest[0];
    const remainder = String(argument).trim().replace(/^\S+\s+\S+\s*/, '');
    const text = remainder || lastUserMessage(session);
    try { const number = await setPreset(slot, text, env); return { output: 'Saved to preset ' + number + ': ' + oneLine(text) + '\nRun it with /presets ' + number + '.' }; }
    catch (error) { return { output: error.message }; }
  }
  if (['clear', 'delete', 'remove', 'rm'].includes(lower)) {
    try { const number = await clearPreset(rest[0], env); return { output: number === 'all' ? 'Cleared all presets.' : 'Cleared preset ' + number + '.' }; }
    catch (error) { return { output: error.message }; }
  }
  const slot = parseSlot(verb);
  if (!slot) return { output: 'Usage: /presets [N | save N [TEXT] | clear N|all]' };
  const text = (await loadPresets(env))[slot - 1];
  if (/^\/presets?(\s|$)/i.test(text)) return { output: 'Preset ' + slot + ' runs /presets itself, so it was not sent. Save a different prompt in it.' };
  if (!text) return { output: 'Preset ' + slot + ' is empty. Save one with /presets save ' + slot + ' TEXT.' };
  return { output: 'Preset ' + slot + ': ' + oneLine(text), queue: text };
}
