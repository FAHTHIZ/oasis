import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadSkillText, loadSkillResource, badSkillName } from '../src/tools.mjs';

test('a tool name passed to load_skill gets told to call the tool', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'oasis-skill-name-'));
  await assert.rejects(loadSkillText(root, 'task_contract'), /"task_contract" is not a skill name.*call that tool directly/);
  await assert.rejects(loadSkillResource(root, 'run_command', 'references/a.md'), /"run_command" is not a skill name/);
  await assert.rejects(loadSkillText(root, '../etc'), (error) => /letters, numbers and hyphens/.test(error.message) && !/call that tool/.test(error.message));
});

test('badSkillName quotes the name and stays short', () => {
  assert.match(badSkillName('x'.repeat(500)), /^"x{80}" is not a skill name/);
});
