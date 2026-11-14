import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadAgentDefinitions } from '../src/subagents.mjs';
import { loadMemory } from '../src/memory.mjs';
import { loadCustomCommands, resolveCustomCommand } from '../src/commands.mjs';

async function fixture(t, files) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-roo-kilo-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const home = path.join(base, 'home');
  await mkdir(root, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const file = rel.startsWith('~/') ? path.join(home, rel.slice(2)) : path.join(root, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), CLAUDE_CONFIG_DIR: path.join(base, 'claude'), OASIS_CONFIG_DIR: path.join(base, 'cfg'), OASIS_OTHER_AGENT_RULES: '' };
  return { root, home, env };
}

const ROOMODES = `customModes:
  - slug: docs-writer
    name: Docs Writer
    description: Writes docs
    roleDefinition: You are a technical writer. You write clear docs.
    whenToUse: Use for README and guide updates.
    customInstructions: Keep sentences short.
    groups:
      - read
      - - edit
        - fileRegex: \\.mdx?$
          description: Markdown only
  - slug: auditor
    name: Auditor
    roleDefinition: You audit code. Nothing else.
    groups: [read, command]
  - slug: bad slug
    roleDefinition: skipped
`;

test('Roo Code .roomodes and Kilo .kilocodemodes become agents with their tool groups and mode rules', async (t) => {
  const { root, env } = await fixture(t, {
    '.roomodes': ROOMODES,
    '.roo/rules-docs-writer/b-style.md': 'ROO-MODE-RULE-B',
    '.roo/rules-docs-writer/sub/A-first.md': 'ROO-MODE-RULE-A',
    '.roorules-docs-writer': 'ROORULES-FALLBACK-UNUSED',
    '~/.roo/rules-docs-writer/global.md': 'ROO-GLOBAL-MODE-RULE',
    '.roorules-auditor': 'AUDITOR-FALLBACK',
    '.kilocodemodes': JSON.stringify({ customModes: [{ slug: 'translator', name: 'Translator', roleDefinition: 'You translate.', groups: ['read', 'edit'] }, { slug: 'auditor', roleDefinition: 'Kilo loses' }] }),
    '.kilocode/rules-translator/terms.md': 'KILO-MODE-RULE',
    '.kilo/agents/kilo-reviewer.md': '---\ndescription: Kilo reviewer\nmode: subagent\n---\nReview.'
  });
  const agents = await loadAgentDefinitions(root, { env });
  const writer = agents['docs-writer'];
  assert.equal(writer.origin, 'Roo Code mode');
  assert.equal(writer.description, 'Use for README and guide updates.');
  assert.match(writer.prompt, /^You are a technical writer[\s\S]*Keep sentences short\.[\s\S]*matches the regular expression `\\\.mdx\?\$` \(Markdown only\)/);
  // Rule files sorted by file name, case-insensitively; global and workspace folders both read; fallback file skipped.
  const a = writer.prompt.indexOf('ROO-MODE-RULE-A');
  const b = writer.prompt.indexOf('ROO-MODE-RULE-B');
  assert.ok(a > 0 && b > a);
  assert.ok(writer.prompt.includes('ROO-GLOBAL-MODE-RULE'));
  assert.equal(writer.prompt.includes('ROORULES-FALLBACK-UNUSED'), false);
  assert.ok(writer.disallowedTools.includes('run_shell') && !writer.disallowedTools.includes('edit_file'));
  const auditor = agents.auditor;
  assert.equal(auditor.description, 'You audit code.');
  assert.ok(auditor.prompt.includes('AUDITOR-FALLBACK'));
  assert.ok(auditor.disallowedTools.includes('edit_file') && !auditor.disallowedTools.includes('run_shell'));
  assert.equal(agents['bad slug'], undefined);
  assert.equal(agents.translator.origin, 'Kilo Code mode');
  assert.ok(agents.translator.prompt.includes('KILO-MODE-RULE'));
  assert.equal(agents['kilo-reviewer'].origin, 'Kilo Code');
});

test('Roo global rules, the .roorules fallback, Kilo rules and Roo commands', async (t) => {
  const { root, home, env } = await fixture(t, {
    '~/.roo/rules/global.md': 'ROO-GLOBAL-RULE',
    '.roorules': 'ROORULES-FILE',
    '.kilocode/rules/kilo.md': 'KILO-RULE',
    '.roo/commands/review.md': '---\ndescription: Review the diff\nargument-hint: <files>\nmode: code\n---\nReview the staged changes.',
    '~/.roo/commands/standup.md': 'Write my standup.'
  });
  let text = await loadMemory(root, { env, home });
  for (const marker of ['ROO-GLOBAL-RULE', 'ROORULES-FILE', 'KILO-RULE']) assert.ok(text.includes(marker), marker);
  await mkdir(path.join(root, '.roo', 'rules'), { recursive: true });
  await writeFile(path.join(root, '.roo', 'rules', 'a.md'), 'ROO-DIR-RULE');
  text = await loadMemory(root, { env, home });
  assert.ok(text.includes('ROO-DIR-RULE'));
  assert.equal(text.includes('ROORULES-FILE'), false, '.roorules is only a fallback');
  const commands = await loadCustomCommands(root, { env, home });
  assert.equal(commands.get('review').description, 'Review the diff (Roo Code)');
  assert.ok(commands.has('standup'));
  const resolved = await resolveCustomCommand(root, '/review src/a.js', { env, home, commands });
  assert.equal(resolved.prompt, 'Review the staged changes.\n\nArguments: src/a.js');
});

test('Roo mode rules past the budget or the 50th file are named instead of dropped', async (t) => {
  const files = { '.roomodes': ROOMODES };
  for (let i = 0; i < 60; i++) files['.roo/rules-docs-writer/r' + String(i).padStart(2, '0') + '.md'] = 'RULE-' + i;
  files['.roo/rules-docs-writer/zz-huge.md'] = 'x'.repeat(60 * 1024);
  const { root, env } = await fixture(t, files);
  const writer = (await loadAgentDefinitions(root, { env }))['docs-writer'];
  assert.ok(writer.prompt.includes('RULE-59'), 'all 60 small rule files are read');
  assert.match(writer.prompt, /1 more rule file did not fit[\s\S]*zz-huge\.md/);
});
