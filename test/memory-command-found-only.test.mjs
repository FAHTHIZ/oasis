// /memory listed about 30 "[none]" lines (every location OASIS checks) even in
// a folder with no instruction files. It now lists files that exist, counts
// the rest, and /memory files shows every checked location.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBuiltinCommand } from '../src/slash.mjs';

test('/memory lists only existing instruction files; /memory files lists all', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-memory-cmd-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'proj');
  await import('node:fs/promises').then((fs) => fs.mkdir(root));
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_AUTO_MEMORY: '1' };
  const empty = (await runBuiltinCommand('memory', '', { root, env })).output;
  assert.doesNotMatch(empty, /\[none\]/);
  assert.match(empty, /Instruction files: none found/);
  assert.match(empty, /other locations checked and not found \(\/memory files/);

  await writeFile(path.join(root, 'AGENTS.md'), '# rules\n');
  const one = (await runBuiltinCommand('memory', '', { root, env })).output;
  assert.match(one, /\[loaded\] project: .*AGENTS\.md/);
  assert.doesNotMatch(one, /\[none\]/);

  const all = (await runBuiltinCommand('memory', 'files', { root, env })).output;
  assert.match(all, /\[loaded\] project: .*AGENTS\.md/);
  assert.match(all, /\[none\] +project: .*CLAUDE\.md/);
});
