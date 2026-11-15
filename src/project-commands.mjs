// The project's own commands, read from files on disk (package.json scripts,
// lockfiles, go.mod, Cargo.toml, pyproject.toml, Makefile). Used by `oasis
// init` so a new OASIS.md names real commands instead of "run relevant checks".
// Only what a file states is reported; nothing is run or guessed.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const NPM_PLACEHOLDER_TEST = /no test specified/i;
const SCRIPT_LABELS = [
  ['test', 'Test'],
  ['lint', 'Lint'],
  ['typecheck', 'Type check'],
  ['type-check', 'Type check'],
  ['check', 'Check'],
  ['build', 'Build'],
  ['format', 'Format'],
  ['dev', 'Dev server'],
  ['start', 'Start']
];

async function exists(root, name) {
  try { await stat(path.join(root, name)); return true; } catch { return false; }
}

async function readText(root, name) {
  try { return await readFile(path.join(root, name), 'utf8'); } catch { return ''; }
}

/** [{ label, command }] for the commands this folder's files define. */
export async function detectProjectCommands(root) {
  const found = [];
  const pkgText = await readText(root, 'package.json');
  if (pkgText) {
    let pkg = null;
    try { pkg = JSON.parse(pkgText); } catch { /* unreadable package.json: skip it */ }
    const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    const runner = await exists(root, 'pnpm-lock.yaml') ? 'pnpm' : await exists(root, 'yarn.lock') ? 'yarn'
      : (await exists(root, 'bun.lockb') || await exists(root, 'bun.lock')) ? 'bun' : 'npm';
    const seen = new Set();
    for (const [name, label] of SCRIPT_LABELS) {
      const script = scripts[name];
      if (typeof script !== 'string' || !script.trim() || seen.has(label)) continue;
      if (name === 'test' && NPM_PLACEHOLDER_TEST.test(script)) continue;
      seen.add(label);
      found.push({ label, command: name === 'test' || name === 'start' ? runner + ' ' + name : runner + ' run ' + name });
    }
  }
  if (await exists(root, 'go.mod')) found.push({ label: 'Test (Go)', command: 'go test ./...' }, { label: 'Vet (Go)', command: 'go vet ./...' });
  if (await exists(root, 'Cargo.toml')) found.push({ label: 'Test (Rust)', command: 'cargo test' }, { label: 'Lint (Rust)', command: 'cargo clippy' });
  const pyproject = await readText(root, 'pyproject.toml');
  const python = pyproject || await exists(root, 'setup.cfg') || await exists(root, 'setup.py') || await exists(root, 'pytest.ini') || await exists(root, 'tox.ini');
  if (python) {
    if (/\[tool\.pytest|pytest/.test(pyproject) || await exists(root, 'pytest.ini') || await exists(root, 'tests') || await exists(root, 'test')) found.push({ label: 'Test (Python)', command: 'python3 -m pytest' });
    if (/\[tool\.ruff/.test(pyproject) || await exists(root, 'ruff.toml') || await exists(root, '.ruff.toml')) found.push({ label: 'Lint (Python)', command: 'ruff check .' });
    if (/\[tool\.mypy/.test(pyproject) || await exists(root, 'mypy.ini')) found.push({ label: 'Type check (Python)', command: 'mypy .' });
  }
  const makefile = await readText(root, 'Makefile') || await readText(root, 'makefile');
  if (makefile) {
    const targets = [...makefile.matchAll(/^([A-Za-z][\w-]*)\s*:(?!=)/gm)].map((match) => match[1]).filter((name, index, all) => all.indexOf(name) === index);
    if (targets.length) found.push({ label: 'Make targets', command: targets.slice(0, 8).map((name) => 'make ' + name).join(', ') });
  }
  return found;
}

/** Markdown lines for a "## Commands" section, or [] when nothing was found. */
export function projectCommandsSection(commands) {
  if (!commands.length) return [];
  return ['## Commands', ...commands.map((item) => '- ' + item.label + ': `' + item.command.replace(/, /g, '`, `') + '`'), ''];
}
