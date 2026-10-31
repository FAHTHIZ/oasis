import { randomUUID } from 'node:crypto';
import { constants as fsConstants, chmodSync, closeSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { redactApprovalSecrets } from './approval-language.mjs';

const MAX_LOG_BYTES = 32 * 1024 * 1024;
const MAX_LINE_CHARS = 1024 * 1024;
const MAX_PENDING_LINE_CHARS = 1024 * 1024;

async function ensureRealDirectory(directory) {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error('Could not create the command log directory: ' + String(error && error.message || error).slice(0, 240));
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Command logs require a real directory, not a symlink.');
  }
  if (await realpath(directory) !== directory) {
    throw new Error('Command log directory resolves outside the expected workspace path.');
  }
}

/**
 * Create private, redacted streaming logs for one non-interactive command.
 * The caller decides whether to retain each file after it knows whether output
 * exceeded the in-memory limit.
 */
export async function createCommandOutputLog(root) {
  const rootPath = await realpath(path.resolve(root));
  const oasisDirectory = path.join(rootPath, '.oasis');
  const logDirectory = path.join(oasisDirectory, 'command-logs');
  await ensureRealDirectory(oasisDirectory);
  await ensureRealDirectory(logDirectory);

  const id = randomUUID();
  const streams = {};
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY |
    (process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW || 0));

  for (const name of ['stdout', 'stderr']) {
    const temporaryPath = path.join(logDirectory, '.' + id + '.' + name + '.tmp');
    const finalPath = path.join(logDirectory, id + '.' + name + '.log');
    const descriptor = openSync(temporaryPath, flags, 0o600);
    streams[name] = {
      descriptor,
      temporaryPath,
      finalPath,
      bytes: 0,
      truncated: false,
      failed: false,
      decoder: new StringDecoder('utf8'),
      pending: '',
      discardUntilNewline: false
    };
  }

  function writeRedacted(state, text) {
    if (!text || state.failed || state.truncated) return;
    const safe = redactApprovalSecrets(text);
    const output = Buffer.from(safe, 'utf8');
    const remaining = MAX_LOG_BYTES - state.bytes;
    if (remaining <= 0) {
      state.truncated = true;
      return;
    }
    try {
      if (output.length > remaining) {
        if (remaining > 0) writeSync(state.descriptor, output, 0, remaining);
        state.bytes += remaining;
        state.truncated = true;
      } else {
        writeSync(state.descriptor, output);
        state.bytes += output.length;
      }
    } catch {
      state.failed = true;
    }
  }

  function append(name, chunk) {
    const state = streams[name];
    if (!state || state.failed || state.truncated) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    state.pending += state.decoder.write(incoming);

    if (state.discardUntilNewline) {
      const newline = state.pending.indexOf('\n');
      if (newline < 0) {
        state.pending = '';
        return;
      }
      state.pending = state.pending.slice(newline + 1);
      state.discardUntilNewline = false;
    }

    let newline = state.pending.indexOf('\n');
    while (newline >= 0) {
      const line = state.pending.slice(0, newline + 1);
      state.pending = state.pending.slice(newline + 1);
      if (line.length > MAX_LINE_CHARS) {
        writeRedacted(state, '[OASIS omitted one output line longer than 1 MiB for safe log redaction.]\n');
      } else {
        writeRedacted(state, line);
      }
      newline = state.pending.indexOf('\n');
      if (state.truncated || state.failed) return;
    }

    if (state.pending.length > MAX_LINE_CHARS) {
      writeRedacted(state, '[OASIS omitted one output line longer than 1 MiB for safe log redaction.]\n');
      state.pending = '';
      state.discardUntilNewline = true;
    } else if (state.pending.length > MAX_PENDING_LINE_CHARS) {
      // Do not split an unusually long line: doing so could separate a key name
      // from its value and leak the remainder after redaction.
      writeRedacted(state, '[OASIS omitted one output line longer than 1 MiB for safe log redaction.]\n');
      state.pending = '';
      state.discardUntilNewline = true;
    }
  }

  function flushState(state) {
    if (state.failed || state.truncated) return;
    if (state.discardUntilNewline) {
      state.pending = '';
      return;
    }
    state.pending += state.decoder.end();
    if (state.pending.length > MAX_LINE_CHARS) {
      writeRedacted(state, '[OASIS omitted one output line longer than 1 MiB for safe log redaction.]');
    } else {
      writeRedacted(state, state.pending);
    }
    state.pending = '';
  }

  let finished = false;
  function finish(retain = {}) {
    if (finished) return {};
    finished = true;
    const result = {};
    for (const name of ['stdout', 'stderr']) {
      const state = streams[name];
      flushState(state);
      try { closeSync(state.descriptor); } catch {}
      const shouldKeep = Boolean(retain[name]) && !state.failed;
      if (shouldKeep) {
        try {
          renameSync(state.temporaryPath, state.finalPath);
          try { chmodSync(state.finalPath, 0o600); } catch {}
          result[name + 'LogPath'] = '.oasis/command-logs/' + path.basename(state.finalPath);
          result[name + 'LogTruncated'] = state.truncated;
        } catch {
          try { unlinkSync(state.temporaryPath); } catch {}
        }
      } else {
        try { unlinkSync(state.temporaryPath); } catch {}
      }
    }
    return result;
  }

  return {
    append,
    finish,
    discard: () => finish()
  };
}
