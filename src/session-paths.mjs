// Where a workspace's saved sessions live. Its own module so event-stream.mjs
// can find the folder without importing sessions.mjs (which imports it back).
import { createHash } from 'node:crypto';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';

export function workspaceSessionKey(root) {
  return createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 20);
}

export function getSessionDirectory(root, env = process.env) {
  return path.join(getConfigDirectory(env), 'sessions', workspaceSessionKey(root));
}
