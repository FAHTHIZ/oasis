#!/usr/bin/env node
// Rehearsal benchmark (docs/REHEARSAL.md): for a corpus of commands, compare the
// files each one really changes with (a) the static prediction effect contracts make
// from the command line and (b) a rehearsal in a copy-on-write overlay.
//
//   node scripts/rehearsal-bench.mjs [--json]
//
// Each command runs three times on identical fresh fixtures: once for real (the
// ground truth), once rehearsed, and once statically predicted.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { predictShellEffects } from '../src/effect-contracts.mjs';
import { disposeRehearsal, rehearsalSupport, rehearseCommand } from '../src/rehearsal.mjs';

const NODE = JSON.stringify(process.execPath);
export const CORPUS = [
  { id: 'sed-in-place', line: 'sed -i s/alpha/ALPHA/ src/a.js' },
  { id: 'redirect', line: 'echo hi > out.txt' },
  { id: 'append', line: 'echo more >> notes.md' },
  { id: 'rm-tree', line: 'rm -rf src/lib' },
  { id: 'mv-rename', line: 'mv src/a.js src/renamed.js' },
  { id: 'cp-into-dir', line: 'cp notes.md src/' },
  { id: 'git-checkout-dot', line: 'git checkout -- .' },
  { id: 'tar-extract', line: 'tar xf bundle.tar' },
  { id: 'python-generator', line: 'python3 gen.py' },
  { id: 'node-formatter', line: NODE + ' fmt.mjs' },
  { id: 'find-delete', line: 'find . -name "*.log" -delete' },
  { id: 'xargs-sed', line: 'git ls-files "*.js" | xargs sed -i s/beta/BETA/' },
  { id: 'make-build', line: 'make' },
  { id: 'npm-script', line: 'npm run --silent build' },
  { id: 'random-content', line: NODE + ' -e "require(\'fs\').writeFileSync(\'rand.txt\', String(Math.random()))"' },
  { id: 'timestamped-name', line: NODE + ' -e "require(\'fs\').writeFileSync(\'build-\' + process.hrtime.bigint() + \'.txt\', \'x\')"' }
];

async function fixture() {
  const root = await mkdtemp(path.join(os.homedir(), '.oasis-rehearsal-bench-'));
  const files = {
    'src/a.js': 'const alpha = 1;\nconst beta = 2;\n',
    'src/b.js': 'export const beta = 3;\n',
    'src/lib/x.js': 'x\n', 'src/lib/y.js': 'y\n',
    'notes.md': '# notes\n',
    'debug.log': 'log\n', 'src/trace.log': 'log\n',
    'gen.py': 'import os\nos.makedirs("generated", exist_ok=True)\nfor i in range(3):\n    open(f"generated/m{i}.py", "w").write(f"N = {i}\\n")\n',
    'fmt.mjs': "import fs from 'node:fs';\nfor (const f of ['src/a.js', 'src/b.js']) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/ = /g, '='));\n",
    'Makefile': 'all: dist/app.js\ndist/app.js: src/a.js src/b.js\n\tmkdir -p dist && cat src/a.js src/b.js > dist/app.js\n',
    'package.json': JSON.stringify({ name: 'bench', version: '1.0.0', scripts: { build: 'node fmt.mjs && mkdir -p dist && echo built > dist/stamp' } }) + '\n'
  };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-qm', 'fixture');
  await mkdir(path.join(root, 'pkg'), { recursive: true });
  await writeFile(path.join(root, 'pkg', 'one.txt'), '1\n');
  await writeFile(path.join(root, 'pkg', 'two.txt'), '2\n');
  execFileSync('tar', ['cf', 'bundle.tar', 'pkg'], { cwd: root });
  await rm(path.join(root, 'pkg'), { recursive: true });
  // Uncommitted edits so `git checkout -- .` has work to do.
  await writeFile(path.join(root, 'src/b.js'), 'export const beta = 4;\n');
  return root;
}

async function state(root) {
  const out = new Map();
  const walk = async (dir, rel) => {
    for (const name of await readdir(dir)) {
      const childRel = rel ? rel + '/' + name : name;
      if (childRel === '.git') continue;
      const full = path.join(dir, name);
      const info = await lstat(full);
      if (info.isDirectory()) await walk(full, childRel);
      else out.set(childRel, (info.mode & 0o777) + ':' + (info.isSymbolicLink() ? 'l:' + await readlink(full) : createHash('sha256').update(await readFile(full)).digest('hex')));
    }
  };
  await walk(root, '');
  return out;
}

function changed(before, after) {
  const paths = new Set();
  for (const [rel, digest] of before) if (after.get(rel) !== digest) paths.add(rel);
  for (const rel of after.keys()) if (!before.has(rel)) paths.add(rel);
  return [...paths].sort();
}

const under = (prefix, rel) => prefix === '.' || prefix === '' || rel === prefix || rel.startsWith(prefix.replace(/\/$/, '') + '/');

export async function runBench() {
  const rows = [];
  for (const item of CORPUS) {
    const real = await fixture();
    const before = await state(real);
    const t0 = Date.now();
    try { execFileSync('/bin/sh', ['-c', item.line], { cwd: real, stdio: 'ignore' }); } catch {}
    const realMs = Date.now() - t0;
    const truth = changed(before, await state(real));
    await rm(real, { recursive: true, force: true });

    const rehearsed = await fixture();
    const result = await rehearseCommand({ root: rehearsed, command: '/bin/sh', args: ['-c', item.line] });
    const shown = [...result.changes.created, ...result.changes.modified, ...result.changes.deleted].sort();
    await disposeRehearsal(result);
    await rm(rehearsed, { recursive: true, force: true });

    const predicted = predictShellEffects(item.line);
    const staticPaths = predicted.paths.map((p) => p.replace(/^\.\//, ''));
    const staticSound = !predicted.broad && truth.every((rel) => staticPaths.some((p) => under(p, rel)));
    const staticExact = !predicted.broad && JSON.stringify([...staticPaths].sort()) === JSON.stringify(truth);
    rows.push({
      id: item.id, truth, rehearsal: shown,
      rehearsalExact: JSON.stringify(shown) === JSON.stringify(truth),
      static: predicted.broad ? 'broad' : staticPaths.join(' '),
      staticSound, staticExact,
      realMs, rehearsalMs: result.ms, status: result.status
    });
  }
  return rows;
}

export function formatBench(rows) {
  const lines = ['| Command | Files really changed | Static prediction | Static exact | Rehearsal exact | Real ms | Rehearsal ms |', '| --- | --- | --- | --- | --- | --- | --- |'];
  for (const row of rows) lines.push('| ' + row.id + ' | ' + row.truth.length + ' | ' + (row.static === 'broad' ? 'broad' : row.staticSound ? 'covers' : 'misses') + ' | ' + (row.staticExact ? 'yes' : 'no') + ' | ' + (row.rehearsalExact ? 'yes' : 'no') + ' | ' + row.realMs + ' | ' + row.rehearsalMs + ' |');
  const count = (key) => rows.filter((row) => row[key]).length;
  const broad = rows.filter((row) => row.static === 'broad').length;
  const misses = rows.filter((row) => row.static !== 'broad' && !row.staticSound).length;
  const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
  lines.push('', 'Static prediction: exact file list for ' + count('staticExact') + ' of ' + rows.length + ', bounded and covering for ' + count('staticSound') + ', broad (unknown) for ' + broad + ', bounded but wrong for ' + misses + '.');
  lines.push('Rehearsal: exact file list for ' + count('rehearsalExact') + ' of ' + rows.length + '. Median time: real ' + median(rows.map((row) => row.realMs)) + ' ms, rehearsal ' + median(rows.map((row) => row.rehearsalMs)) + ' ms.');
  return lines.join('\n');
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const support = rehearsalSupport();
  if (!support.available) { console.error('Rehearsal unavailable: ' + support.reason); process.exit(2); }
  const rows = await runBench();
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else console.log(formatBench(rows));
}
