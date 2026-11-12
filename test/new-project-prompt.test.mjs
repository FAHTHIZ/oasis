import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { workspaceIsEmpty } from '../src/agent.mjs';
import { systemPrompt, compactSystemPrompt, NEW_PROJECT_RULE } from '../src/system-prompt.mjs';

test('an empty folder (dotfiles only) is a new project', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-new-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await workspaceIsEmpty(dir), true);
  await mkdir(path.join(dir, '.git'));
  await writeFile(path.join(dir, '.gitignore'), 'node_modules\n');
  assert.equal(await workspaceIsEmpty(dir), true);
  await writeFile(path.join(dir, 'index.js'), '');
  assert.equal(await workspaceIsEmpty(dir), false);
  assert.equal(await workspaceIsEmpty(path.join(dir, 'missing')), false);
});

test('the prompt asks for built-in tools only when the workspace is new', () => {
  const fresh = 'Platform: linux\nWorkspace: empty (a new project)\nGit repository: no';
  assert.ok(systemPrompt('/w', '', '', fresh).includes(NEW_PROJECT_RULE));
  assert.match(compactSystemPrompt('/w', '', '', fresh), /starting a new project.*node:test/s);
  assert.ok(!systemPrompt('/w', '', '', 'Platform: linux\nGit repository: no').includes('starting a new project'));
  assert.ok(!compactSystemPrompt('/w', '', '', 'Platform: linux').includes('starting a new project'));
});
