// OpenAI "V4A" apply_patch format (`*** Begin Patch` … `*** End Patch`).
// GPT-5.x and Codex models are trained to edit files with it: through an
// `apply_patch` function, a freeform tool whose arguments are the raw patch, or
// a shell call such as `apply_patch <<'EOF' … EOF`. OASIS does not advertise a
// tool for it (no schema cost); when a model emits one anyway, agent.mjs turns
// the patch into ordinary write_file / delete_file calls so every permission,
// hook, approval, protected-path check, snapshot and file lock still applies.
//
// This module is pure: it parses a patch and computes new file contents from
// the current ones. Ported from OpenAI's reference implementation
// (openai-cookbook examples/gpt-5/apply_patch.py), with two deliberate
// differences: CRLF files match LF patches (lines are compared without "\r";
// write_file restores the file's endings), and added files end with a newline,
// as Codex's own apply_patch does.

export class PatchError extends Error {
  constructor(message) { super(message); this.name = 'PatchError'; }
}

const SECTION_ENDS = ['*** End Patch', '*** Update File:', '*** Delete File:', '*** Add File:', '*** End of File'];
const startsWithAny = (line, prefixes) => prefixes.some((prefix) => line.startsWith(prefix));

/** Pull the patch body out of a tool argument, freeform text or a shell command. */
export function extractPatchText(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n/g, '\n');
  const begin = text.indexOf('*** Begin Patch');
  if (begin === -1) return null;
  const end = text.indexOf('*** End Patch', begin);
  if (end === -1) return null;
  return text.slice(begin, end + '*** End Patch'.length);
}

/** Paths a patch reads (updates and deletes), so callers can load them first. */
export function patchFilesNeeded(text) {
  const out = new Set();
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('*** Update File: ')) out.add(line.slice(17).trim());
    else if (line.startsWith('*** Delete File: ')) out.add(line.slice(17).trim());
  }
  return [...out];
}

function findContextCore(lines, context, start) {
  if (!context.length) return { index: start, fuzz: 0 };
  const tries = [[(s) => s, 0], [(s) => s.trimEnd(), 1], [(s) => s.trim(), 100]];
  for (const [norm, fuzz] of tries) {
    const want = context.map(norm);
    for (let i = Math.max(0, start); i + context.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < want.length; j++) if (norm(lines[i + j]) !== want[j]) { ok = false; break; }
      if (ok) return { index: i, fuzz };
    }
  }
  return { index: -1, fuzz: 0 };
}

function findContext(lines, context, start, eof) {
  if (eof) {
    const atEnd = findContextCore(lines, context, lines.length - context.length);
    if (atEnd.index !== -1) return atEnd;
    const anywhere = findContextCore(lines, context, start);
    return { index: anywhere.index, fuzz: anywhere.fuzz + 10000 };
  }
  return findContextCore(lines, context, start);
}

function peekNextSection(lines, start) {
  const old = [];
  let del = [];
  let ins = [];
  const chunks = [];
  let mode = 'keep';
  let index = start;
  while (index < lines.length) {
    let line = lines[index];
    if (line === '***' || startsWithAny(line, ['@@', ...SECTION_ENDS])) break;
    if (line.startsWith('***')) throw new PatchError('Invalid line in patch: ' + line);
    index++;
    const lastMode = mode;
    if (line === '') line = ' ';
    if (line[0] === '+') mode = 'add';
    else if (line[0] === '-') mode = 'delete';
    else if (line[0] === ' ') mode = 'keep';
    else throw new PatchError('Invalid line in patch (each line must start with " ", "+" or "-"): ' + line);
    line = line.slice(1);
    if (mode === 'keep' && lastMode !== mode) {
      if (ins.length || del.length) chunks.push({ origIndex: old.length - del.length, del, ins });
      del = []; ins = [];
    }
    if (mode === 'delete') { del.push(line); old.push(line); }
    else if (mode === 'add') ins.push(line);
    else old.push(line);
  }
  if (ins.length || del.length) chunks.push({ origIndex: old.length - del.length, del, ins });
  if (index < lines.length && lines[index] === '*** End of File') return { old, chunks, index: index + 1, eof: true };
  if (index === start) throw new PatchError('Empty section in patch near: ' + (lines[index] || 'end of patch'));
  return { old, chunks, index, eof: false };
}

function applyChunks(text, chunks, path) {
  const orig = text.split('\n');
  const dest = [];
  let at = 0;
  for (const chunk of chunks) {
    if (chunk.origIndex > orig.length || at > chunk.origIndex) throw new PatchError('Hunks for ' + path + ' overlap or are out of order.');
    dest.push(...orig.slice(at, chunk.origIndex));
    dest.push(...chunk.ins);
    at = chunk.origIndex + chunk.del.length;
  }
  dest.push(...orig.slice(at));
  return dest.join('\n');
}

/**
 * Parse a V4A patch against the current contents of the files it touches.
 * `files` maps each path from patchFilesNeeded() to its text (missing = absent).
 * Returns { operations: [{ type: 'add'|'update'|'delete', path, content?, moveTo? }], fuzz }.
 * Nothing is written; a PatchError means no operation should be applied.
 */
export function planPatch(patchText, files = {}) {
  const text = extractPatchText(patchText);
  if (!text) throw new PatchError('A patch must start with "*** Begin Patch" and end with "*** End Patch".');
  const lines = text.split('\n');
  const operations = [];
  const seen = new Set();
  let fuzz = 0;
  let i = 1;
  const current = (path) => {
    const value = files[path];
    if (typeof value !== 'string') return null;
    return value.replace(/^\ufeff/, '').replace(/\r\n/g, '\n');
  };
  const claim = (path, kind) => {
    if (!path) throw new PatchError(kind + ' needs a file path.');
    if (seen.has(path)) throw new PatchError('The patch touches ' + path + ' twice; combine its hunks into one section.');
    seen.add(path);
  };
  while (i < lines.length && !lines[i].startsWith('*** End Patch')) {
    const line = lines[i];
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice(17).trim();
      claim(path, 'Update File');
      i++;
      let moveTo = '';
      if (i < lines.length && lines[i].startsWith('*** Move to: ')) { moveTo = lines[i].slice(13).trim(); i++; }
      const original = current(path);
      if (original === null) throw new PatchError('Update File: ' + path + ' does not exist (use "*** Add File:" to create it).');
      const fileLines = original.split('\n');
      const chunks = [];
      let index = 0;
      while (i < lines.length && !startsWithAny(lines[i], SECTION_ENDS)) {
        let header = '';
        let bare = false;
        if (lines[i].startsWith('@@ ')) { header = lines[i].slice(3); i++; }
        else if (lines[i] === '@@') { bare = true; i++; }
        if (!header && !bare && index !== 0) throw new PatchError('Expected an "@@" line in ' + path + ', got: ' + lines[i]);
        if (header.trim()) {
          let found = false;
          if (!fileLines.slice(0, index).some((s) => s === header)) {
            for (let k = index; k < fileLines.length; k++) if (fileLines[k] === header) { index = k + 1; found = true; break; }
          }
          if (!found && !fileLines.slice(0, index).some((s) => s.trim() === header.trim())) {
            for (let k = index; k < fileLines.length; k++) if (fileLines[k].trim() === header.trim()) { index = k + 1; found = true; fuzz++; break; }
          }
        }
        const section = peekNextSection(lines, i);
        const match = findContext(fileLines, section.old, index, section.eof);
        if (match.index === -1) {
          throw new PatchError('Could not find these lines in ' + path + (section.eof ? ' (at end of file)' : '') + ':\n' + section.old.slice(0, 12).join('\n') + (section.old.length > 12 ? '\n…' : '') + '\nRead the file again and copy its current text exactly.');
        }
        fuzz += match.fuzz;
        for (const chunk of section.chunks) chunks.push({ ...chunk, origIndex: chunk.origIndex + match.index });
        index = match.index + section.old.length;
        i = section.index;
      }
      if (i < lines.length && lines[i] === '*** End of File') i++;
      operations.push({ type: 'update', path, content: applyChunks(original, chunks, path), ...(moveTo && moveTo !== path ? { moveTo } : {}) });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      claim(path, 'Delete File');
      if (current(path) === null) throw new PatchError('Delete File: ' + path + ' does not exist.');
      operations.push({ type: 'delete', path });
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      claim(path, 'Add File');
      i++;
      const added = [];
      while (i < lines.length && !startsWithAny(lines[i], ['*** End Patch', '*** Update File:', '*** Delete File:', '*** Add File:'])) {
        if (!lines[i].startsWith('+')) throw new PatchError('Every line of an added file must start with "+" (' + path + '): ' + lines[i]);
        added.push(lines[i].slice(1));
        i++;
      }
      operations.push({ type: 'add', path, content: added.length ? added.join('\n') + '\n' : '' });
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    throw new PatchError('Unknown line in patch: ' + line);
  }
  if (i >= lines.length) throw new PatchError('The patch is missing "*** End Patch".');
  if (!operations.length) throw new PatchError('The patch has no file sections.');
  return { operations, fuzz };
}

const squash = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Recognize an apply_patch request in a tool call: the apply_patch name (any
 * spelling) with { patch | input | diff } or raw freeform text, or a shell /
 * command call that runs apply_patch with the patch inline. Returns the patch
 * text or null.
 */
export function patchFromToolCall(name, rawArguments, parsedArgs) {
  const args = parsedArgs && typeof parsedArgs === 'object' ? parsedArgs : {};
  const key = squash(name);
  if (key === 'applypatch' || key === 'applypatchgrammar') {
    for (const field of ['patch', 'input', 'diff', 'content']) {
      const found = extractPatchText(args[field]);
      if (found) return found;
    }
    if (Array.isArray(args.command)) { const found = extractPatchText(args.command.join('\n')); if (found) return found; }
    return extractPatchText(typeof rawArguments === 'string' ? rawArguments : '');
  }
  if (key === 'runcommand' || key === 'runshell' || key === 'shell' || key === 'bash' || key === 'localshell' || key === 'exec' || key === 'execcommand') {
    const parts = [];
    if (typeof args.command === 'string') parts.push(args.command);
    if (Array.isArray(args.command)) parts.push(...args.command.map(String));
    if (Array.isArray(args.cmd)) parts.push(...args.cmd.map(String));
    if (typeof args.cmd === 'string') parts.push(args.cmd);
    if (Array.isArray(args.args)) parts.push(...args.args.map(String));
    const joined = parts.join('\n');
    // Only a command that is apply_patch itself (optionally via bash -lc / sh -c), never a script that mentions it.
    const head = joined.replace(/^\s*(?:(?:ba|z)?sh\s+-l?c\s+)?['"]?\s*(?:cd\s+\S+\s*&&\s*)?/, '');
    if (!/^apply_patch\b/.test(head)) return null;
    return extractPatchText(joined);
  }
  return null;
}
