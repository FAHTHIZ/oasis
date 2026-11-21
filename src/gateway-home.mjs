// The home channel: one chat, picked with /sethome from any gateway, that
// routines can deliver to with `--deliver home`. It lives in the user's
// config directory (next to the routine store), so every workspace and the
// scheduler daemon agree on it.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';

export function homeFile(env = process.env) {
  return path.join(getConfigDirectory(env), 'gateway-home.json');
}

/** { target: 'telegram:42', label, at } or null. */
export function readHome(env = process.env) {
  try {
    const data = JSON.parse(readFileSync(homeFile(env), 'utf8'));
    return data && typeof data.target === 'string' && /^[a-z]+:.+/.test(data.target) ? data : null;
  } catch { return null; }
}

export function writeHome(target, { env = process.env, label = '', now = () => Date.now() } = {}) {
  const file = homeFile(env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const data = { target: String(target), label: String(label || '').slice(0, 120), at: new Date(now()).toISOString() };
  const temp = file + '.' + process.pid + '.tmp';
  writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, file);
  return data;
}

/** The delivery destination for a chat key (chat keys can include a thread). */
export function homeDestination(platform, chatKey) {
  const key = String(chatKey);
  if (platform === 'slack' || platform === 'mattermost') return key.split(':')[0];
  if (platform === 'email') return key.split(' ')[0];
  return key;
}

/** Handles /sethome and /home; returns the reply text, or null for other commands. */
export function homeCommand(cmd, { platform, chatKey, label = '', env = process.env }) {
  if (cmd === '/sethome') {
    const previous = readHome(env);
    const target = platform + ':' + homeDestination(platform, chatKey);
    writeHome(target, { env, label });
    return 'This chat is now the home channel (' + target + ').' + (previous && previous.target !== target ? ' It replaces ' + previous.target + '.' : '') + ' Routines created with --deliver home post their results here.';
  }
  if (cmd === '/home') {
    const home = readHome(env);
    return home ? 'Home channel: ' + home.target + (home.label ? ' (' + home.label + ')' : '') + ', set ' + String(home.at || '').slice(0, 10) + '. Send /sethome to move it here.' : 'No home channel yet. Send /sethome in the chat where routine results should arrive.';
  }
  return null;
}
