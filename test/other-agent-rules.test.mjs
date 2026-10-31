import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadMemory } from '../src/memory.mjs';

async function workspace(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-rules-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-rules-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
  return { root, env: { ...process.env, OASIS_CONFIG_DIR: path.join(home, 'cfg'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'), OASIS_DISABLE_PARENT_MEMORY: '1' }, home };
}
const text = (memory) => typeof memory === 'string' ? memory : JSON.stringify(memory);

test('instruction files written for other agents are loaded', async (t) => {
  const { root, env, home } = await workspace(t, {
    'GEMINI.md': 'Use pnpm, never npm.',
    '.github/copilot-instructions.md': 'Prefer named exports.',
    '.cursorrules': 'Tabs, not spaces.',
    '.windsurfrules': 'No default exports.',
    'CONVENTIONS.md': 'Write tests with vitest.',
    '.clinerules/readme.md': 'directory form is ignored here'
  });
  const memory = text(await loadMemory(root, { env, home }));
  for (const rule of ['Use pnpm, never npm.', 'Prefer named exports.', 'Tabs, not spaces.', 'No default exports.', 'Write tests with vitest.']) assert.ok(memory.includes(rule), rule);
  assert.match(memory, /Project context: GEMINI\.md/);
  assert.match(memory, /Project context: \.github[\\/]+copilot-instructions\.md/);
});

test('identical copies load once and the import can be turned off', async (t) => {
  const rule = '# Rules\n\nAlways run make check before committing.\n';
  const { root, env, home } = await workspace(t, { 'AGENTS.md': rule, 'CLAUDE.md': rule, 'GEMINI.md': rule.replace('\n\n', '\n') });
  const memory = text(await loadMemory(root, { env, home }));
  assert.equal(memory.split('Always run make check').length - 1, 1);
  const off = text(await loadMemory(root, { env: { ...env, OASIS_OTHER_AGENT_RULES: '0' }, home }));
  assert.doesNotMatch(off, /GEMINI\.md/);
});
