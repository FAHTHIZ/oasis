import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeTool } from '../src/tools.mjs';
import { subagentDefinitionContext } from '../src/subagent-support.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-skill-pages-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const home = path.join(base, 'home');
  const lines = Array.from({ length: 1500 }, (_, i) => 'Step ' + i + ': follow the long checklist item carefully.');
  const body = '---\nname: big-skill\ndescription: a long skill\n---\n' + lines.join('\n') + '\nEND-OF-SKILL\n';
  await mkdir(path.join(root, '.claude/skills/big-skill/references'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(root, '.claude/skills/big-skill/SKILL.md'), body);
  await mkdir(path.join(root, '.claude/skills/small-skill'), { recursive: true });
  await writeFile(path.join(root, '.claude/skills/small-skill/SKILL.md'), '---\nname: small-skill\ndescription: a short skill\n---\nSMALL-SKILL-BODY\n');
  await writeFile(path.join(root, '.claude/skills/big-skill/references/long.md'), lines.join('\n') + '\nEND-OF-REFERENCE\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, OASIS_CONFIG_DIR: path.join(home, '.oasis') };
  return { root, env, body };
}

// Skills reach 96 KiB; load_skill cut them at 24k characters with no way on.
test('load_skill pages a long skill to the end on line breaks', async (t) => {
  const { root, env, body } = await fixture(t);
  const ctx = { root, env, session: { config: {} }, autoApprove: true, approval: async () => true };
  let text = '';
  let offset = 0;
  for (let i = 0; i < 10; i++) {
    const page = await executeTool('load_skill', { name: 'big-skill', ...(offset ? { offset } : {}) }, ctx);
    assert.ok(page.content.length <= 20000);
    text += page.content;
    if (!page.truncated) break;
    assert.ok(page.content.endsWith('\n'));
    assert.match(page.note, /offset=\d+/);
    offset = page.nextOffset;
  }
  assert.equal(text, body);
});

test('read_skill_resource pages a long reference', async (t) => {
  const { root, env } = await fixture(t);
  const ctx = { root, env, session: { config: {} }, autoApprove: true, approval: async () => true };
  const first = await executeTool('read_skill_resource', { name: 'big-skill', path: 'references/long.md' }, ctx);
  assert.equal(first.truncated, true);
  const rest = [];
  let page = first;
  for (let i = 0; page.truncated && i < 10; i++) { assert.ok(Number.isInteger(page.nextOffset)); page = await executeTool('read_skill_resource', { name: 'big-skill', path: 'references/long.md', offset: page.nextOffset }, ctx); rest.push(page.content); }
  assert.match(rest.at(-1), /END-OF-REFERENCE/);
});

test('a subagent definition preloads the skill text, not "[object Object]"', async (t) => {
  const { root, env } = await fixture(t);
  const sections = await subagentDefinitionContext({ root }, { skills: ['small-skill'] }, { env });
  const text = Array.isArray(sections) ? sections.join('\n') : String(sections);
  assert.doesNotMatch(text, /\[object Object\]/);
  assert.match(text, /SMALL-SKILL-BODY/);
});
