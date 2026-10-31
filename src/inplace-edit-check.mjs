// Silent no-op edit check. When an agent edits files through `sed -i`,
// `perl -pi` or a little Python/Node script with `.replace(...)`, a pattern
// that does not match changes nothing and still exits 0 — unlike edit_file,
// which fails loudly. Users report agents then claiming the change was made.
// Hash the files a scripted edit names before it runs; if it "succeeds" but
// none of them changed, say so in the tool result.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILES = 20;
const MAX_SIZE = 5 * 1024 * 1024;

const SED_INPLACE = /(?:^|[\s;&|(])(?:g?sed)\s+(?:[^;&|\n]*\s)?(?:-[a-zA-Z]*i[^\s]*|--in-place(?:=\S*)?)(?:\s|$)/;
const PERL_INPLACE = /(?:^|[\s;&|(])perl\s+(?:[^;&|\n]*\s)?-[a-zA-Z]*i[a-zA-Z.]*(?:\s|$)/;
const SCRIPT_EDIT = /(?:^|[\s;&|(])(?:python3?|py|node|ruby)\b[\s\S]*(?:\.replace\(|re\.sub\(|\.gsub!?\(|\.sub!?\()[\s\S]*(?:write_text\(|\.write\(|writeFileSync\(|File\.write)/;

export function scriptedEditKind(commandText) {
  const text = String(commandText || '');
  if (SED_INPLACE.test(text)) return 'sed -i';
  if (PERL_INPLACE.test(text)) return 'perl -i';
  if (SCRIPT_EDIT.test(text)) return 'script';
  return '';
}

// Words in the command that look like file paths (plain args or quoted names in inline code).
export function candidatePaths(commandText) {
  const text = String(commandText || '');
  const found = new Set();
  for (const match of text.matchAll(/["']([\w@~./+-]+\.[A-Za-z0-9]{1,10})["']/g)) found.add(match[1]);
  for (const raw of text.split(/[\s;&|()<>]+/)) {
    const word = raw.replace(/^["']|["']$/g, '');
    if (!word || word.startsWith('-') || /[*?{}$`=\\]/.test(word) || /^s[/|#,:]/.test(word)) continue;
    if (/^[\w@~.+-]*\/?[\w@~./+-]*\.[A-Za-z0-9]{1,10}$/.test(word) || /\//.test(word)) found.add(word);
  }
  return [...found].slice(0, MAX_FILES * 3);
}

async function digest(file) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_SIZE) return null;
    return createHash('sha256').update(await readFile(file)).digest('hex');
  } catch { return null; }
}

// Returns a snapshot object, or null when the command is not a scripted edit
// or names no existing workspace file.
export async function snapshotScriptedEdit(root, commandText, env = process.env) {
  if (/^(0|false|off|no)$/i.test(String(env.OASIS_NOOP_EDIT_CHECK || ''))) return null;
  const kind = scriptedEditKind(commandText);
  if (!kind) return null;
  const base = path.resolve(root);
  const files = [];
  for (const candidate of candidatePaths(commandText)) {
    if (files.length >= MAX_FILES) break;
    const absolute = path.resolve(base, candidate);
    if (absolute !== base && !absolute.startsWith(base + path.sep)) continue;
    if (files.some((item) => item.absolute === absolute)) continue;
    const hash = await digest(absolute);
    if (hash) files.push({ absolute, display: path.relative(base, absolute).split(path.sep).join('/'), hash });
  }
  return files.length ? { kind, files } : null;
}

export async function noOpEditWarning(snapshot, exitCode) {
  if (!snapshot || exitCode !== 0) return '';
  for (const file of snapshot.files) {
    if ((await digest(file.absolute)) !== file.hash) return '';
  }
  const names = snapshot.files.map((file) => file.display).join(', ');
  return 'No-op edit: this ' + snapshot.kind + ' command exited 0 but ' + names + (snapshot.files.length > 1 ? ' are' : ' is') +
    ' byte-for-byte unchanged, so the pattern most likely did not match. Do not report the change as made. ' +
    'Read the file to check the exact text, then use edit_file (which fails loudly on a missing match) instead of a scripted replace.';
}
