// Superseded tool results: when a newer tool result makes an older one in the
// conversation redundant, the older one is replaced by a one-line stub.
//
// Every request resends the whole history, so a 4,000-character file read
// that the model later reads again in full is paid for twice on every later
// step, and the older copy is stale if the file changed in between. Only
// results that a newer result in the conversation fully covers are replaced:
//
//  - read_file: an older read of the same file whose line range lies inside a
//    newer read's range (a complete read covers everything). The newer read
//    must be a real read (not a "file unchanged" pointer, not shortened to fit
//    the window).
//  - run_command / run_shell: an older finished run of the identical command.
//    The stub keeps the exit code and the last lines of the old output.
//  - git_status / git_diff: an older call with the same arguments.
//
// Appended <system-reminder> text is kept. Disable with
// OASIS_SUPERSEDE_RESULTS=0 or "supersedeResults": false in the config.

import path from 'node:path';

const MIN_CHARS = 400;
const TAIL_CHARS = 300;
const SHORTENED = '[OASIS shortened this ';

function safeArgs(text) {
  if (!text) return {};
  if (typeof text === 'object') return text;
  try { const value = JSON.parse(text); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}

// Splits "<json>\n\n<appended notes>" into the parsed JSON and the notes.
function parseToolContent(content) {
  if (typeof content !== 'string' || !content.startsWith('{')) return null;
  try { return { value: JSON.parse(content), tail: '' }; } catch { /* has appended text */ }
  let at = content.indexOf('\n\n');
  while (at !== -1) {
    try { return { value: JSON.parse(content.slice(0, at)), tail: content.slice(at) }; } catch { /* keep looking */ }
    at = content.indexOf('\n\n', at + 2);
  }
  return null;
}

function readRange(value) {
  // Unranged complete reads carry no line metadata.
  if (value.startLine === undefined && value.totalLines === undefined) return value.truncated === true ? null : [1, Infinity];
  const start = Number(value.startLine);
  const end = Number(value.endLine);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start === 1 && value.truncated !== true && Number(value.totalLines) === end) return [1, Infinity];
  return [start, end];
}

function commandKey(name, args) {
  if (name === 'run_shell') return typeof args.command === 'string' ? 'sh\u0000' + args.command.trim() : '';
  if (typeof args.command !== 'string') return '';
  if (args.run_in_background || args.interactive) return '';
  return 'cmd\u0000' + JSON.stringify([args.command.trim(), Array.isArray(args.args) ? args.args.map(String) : []]);
}

// What a result covers, read from its serialized content, or null when it
// can supersede nothing.
function coverage(name, args, value, content, root) {
  if (!value || typeof value !== 'object' || value.error || value.superseded) return null;
  if (typeof content === 'string' && content.includes(SHORTENED)) return null;
  if (name === 'read_file') {
    if (typeof value.content !== 'string' || value.unchanged || typeof value.path !== 'string') return null;
    const range = readRange(value);
    return range ? { kind: 'read', file: path.resolve(root, value.path), range } : null;
  }
  if (name === 'run_command' || name === 'run_shell') {
    const key = commandKey(name, args);
    if (!key || typeof value.exitCode !== 'number' || value.approved === false || value.id) return null;
    return { kind: 'command', key };
  }
  if (name === 'git_status' || name === 'git_diff') {
    if (value.exitCode !== 0 || value.truncated) return null;
    return { kind: 'git', key: gitKey(name, args) };
  }
  return null;
}

function gitKey(name, args) {
  return name + '\u0000' + JSON.stringify({ scope: args.scope || 'all', path: args.path || '' });
}

function covered(cover, name, args, value, root) {
  if (cover.kind === 'read') {
    if (name !== 'read_file' || typeof value.path !== 'string' || typeof value.content !== 'string') return false;
    const range = readRange(value) || [Number(value.startLine) || 1, Number(value.endLine) || Infinity];
    return path.resolve(root, value.path) === cover.file && cover.range[0] <= range[0] && range[1] <= cover.range[1];
  }
  if (cover.kind === 'command') {
    return (name === 'run_command' || name === 'run_shell') && typeof value.exitCode === 'number' && !value.id && commandKey(name, args) === cover.key;
  }
  return (name === 'git_status' || name === 'git_diff') && value.exitCode === 0 && gitKey(name, args) === cover.key;
}

function stubFor(name, value, cover) {
  if (cover.kind === 'read') {
    return { path: value.path, superseded: true, note: 'Older read of this file, omitted: a later read_file result in this conversation shows ' + (cover.range[1] === Infinity ? 'the whole file' : 'these lines') + ' as they are now.' };
  }
  if (cover.kind === 'command') {
    const output = [value.stdout, value.stderr, value.output].filter((part) => typeof part === 'string' && part).join('\n');
    const tail = output.length > TAIL_CHARS ? '...' + output.slice(-TAIL_CHARS) : output;
    return { ...(value.command !== undefined ? { command: value.command } : {}), exitCode: value.exitCode, superseded: true, note: 'Older run of this command; output omitted because the same command ran again later (see the newer result). Last lines were:', tail };
  }
  return { superseded: true, note: 'Older ' + name + ' result, omitted: the same call ran again later; see the newer result.' };
}

/**
 * Returns a copy of `messages` in which every tool result that a later result
 * fully covers is replaced by a short stub. Lossless: whatever is removed is
 * still in the conversation in a newer form. Never mutates the input.
 *
 * It is not applied on every step: rewriting an old message breaks the
 * provider's prefix cache (and llama.cpp's KV cache) from that point, which
 * costs more than it saves on a short task (bench/tokens measured +12% cache-
 * weighted input on taskflow-search). It runs when the context is already
 * being compacted, before anything lossy is dropped.
 */
export function supersedeHistory(messages, { root = process.cwd(), env = process.env, config = {} } = {}) {
  if (!Array.isArray(messages)) return { messages, saved: 0, replaced: 0 };
  if (/^(0|false|off|no)$/i.test(String(env.OASIS_SUPERSEDE_RESULTS || '')) || config.supersedeResults === false) return { messages, saved: 0, replaced: 0 };
  const callArgs = new Map();
  for (const message of messages) {
    if (message && message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) if (call && call.id) callArgs.set(call.id, safeArgs(call.function && call.function.arguments));
    }
  }
  const covers = [];
  let output = messages;
  let saved = 0;
  let replaced = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== 'tool' || typeof message.content !== 'string' || message.images) continue;
    const name = message.name;
    if (!['read_file', 'run_command', 'run_shell', 'git_status', 'git_diff'].includes(name)) continue;
    const parsed = parseToolContent(message.content);
    if (!parsed || !parsed.value || typeof parsed.value !== 'object') continue;
    const value = parsed.value;
    const args = callArgs.get(message.tool_call_id) || {};
    const by = message.content.length >= MIN_CHARS && !value.superseded ? covers.find((cover) => covered(cover, name, args, value, root)) : null;
    if (by) {
      const replacement = JSON.stringify(stubFor(name, value, by)) + parsed.tail;
      if (replacement.length < message.content.length) {
        if (output === messages) output = messages.slice();
        output[i] = { ...message, content: replacement };
        saved += message.content.length - replacement.length;
        replaced++;
        continue;
      }
    }
    const own = coverage(name, args, value, message.content, root);
    if (own) covers.push(own);
  }
  return { messages: output, saved, replaced };
}
