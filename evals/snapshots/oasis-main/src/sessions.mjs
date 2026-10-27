import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile, chmod, unlink } from 'node:fs/promises';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';

const MAX_SESSION_BYTES = 3 * 1024 * 1024;
const MAX_MESSAGES = 120;

export function workspaceSessionKey(root) {
  return createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 20);
}

function validateId(id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{20,80}$/i.test(id)) throw new Error('Invalid session ID.');
  return id;
}

export function getSessionDirectory(root, env = process.env) {
  return path.join(getConfigDirectory(env), 'sessions', workspaceSessionKey(root));
}

function sessionPath(root, id, env = process.env) {
  return path.join(getSessionDirectory(root, env), validateId(id) + '.json');
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES) throw new Error('Session history has an invalid message count.');
  for (const item of messages) {
    if (!item || typeof item !== 'object' || !['system', 'user', 'assistant', 'tool'].includes(item.role)) throw new Error('Session history contains an invalid message.');
    if (item.content !== undefined && item.content !== null && typeof item.content !== 'string') throw new Error('Session history contains non-text message content.');
    if (item.tool_calls !== undefined && (!Array.isArray(item.tool_calls) || item.tool_calls.length > 30)) throw new Error('Session history contains invalid tool calls.');
    if (item.role === 'tool' && typeof item.tool_call_id !== 'string') throw new Error('Session history contains a tool result without an ID.');
  }
  if (messages[0].role !== 'system') throw new Error('Session history must begin with system context.');
  return messages;
}

export async function saveSession(session, options = {}) {
  if (!session || !Array.isArray(session.messages)) throw new Error('There is no active session to save.');
  const env = options.env || process.env;
  const id = session.sessionId && validateId(session.sessionId) || randomUUID();
  const messages = validateMessages(session.messages.slice(-MAX_MESSAGES));
  const payload = {
    schemaVersion: 1,
    id,
    workspaceRoot: path.resolve(session.root),
    updatedAt: new Date().toISOString(),
    provider: {
      protocol: session.config && session.config.protocol || 'openai-compatible',
      baseURL: session.config && session.config.baseURL || '',
      model: session.config && session.config.model || ''
    },
    messages
  };
  const body = JSON.stringify(payload, null, 2) + '\n';
  if (Buffer.byteLength(body, 'utf8') > MAX_SESSION_BYTES) throw new Error('Session is too large to save safely. Start a fresh session or disable persistence.');
  const directory = getSessionDirectory(session.root, env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = sessionPath(session.root, id, env);
  const temp = destination + '.' + randomUUID() + '.tmp';
  await writeFile(temp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await rename(temp, destination);
    try { await chmod(destination, 0o600); } catch {}
  } catch (error) {
    try { await unlink(temp); } catch {}
    throw error;
  }
  session.sessionId = id;
  return { id, path: destination, updatedAt: payload.updatedAt };
}

export async function loadSession(root, id, options = {}) {
  const env = options.env || process.env;
  const source = await readFile(sessionPath(root, id, env), 'utf8');
  if (Buffer.byteLength(source, 'utf8') > MAX_SESSION_BYTES) throw new Error('Stored session is too large.');
  const payload = JSON.parse(source);
  if (!payload || payload.schemaVersion !== 1 || payload.id !== id || path.resolve(payload.workspaceRoot || '') !== path.resolve(root)) {
    throw new Error('That saved session does not belong to this workspace or uses an unsupported format.');
  }
  return {
    id: validateId(payload.id),
    updatedAt: String(payload.updatedAt || ''),
    provider: payload.provider || {},
    messages: validateMessages(payload.messages)
  };
}

export async function listSessions(root, options = {}) {
  const env = options.env || process.env;
  const directory = getSessionDirectory(root, env);
  let names;
  try { names = await readdir(directory); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const sessions = [];
  for (const name of names) {
    if (!/^[a-f0-9-]{20,80}\.json$/i.test(name)) continue;
    try {
      const data = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
      if (data && data.schemaVersion === 1 && path.resolve(data.workspaceRoot || '') === path.resolve(root)) {
        sessions.push({ id: data.id, updatedAt: data.updatedAt, model: data.provider && data.provider.model || '', messages: Array.isArray(data.messages) ? data.messages.length : 0 });
      }
    } catch { /* Ignore corrupt session files in listings. */ }
  }
  return sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function deleteSession(root, id, options = {}) {
  const target = sessionPath(root, id, options.env || process.env);
  const data = await loadSession(root, id, options);
  await unlink(target);
  return { id: data.id, deleted: true };
}
