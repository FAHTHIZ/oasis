import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { loadMemory, nestedMemoryFor, projectRules } from '../src/memory.mjs';

async function workspace(t, files) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-rules-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
  const env = { ...process.env, HOME: path.join(base, 'home'), CLAUDE_CONFIG_DIR: path.join(base, 'claude'), OASIS_CONFIG_DIR: path.join(base, 'cfg'), OASIS_OTHER_AGENT_RULES: '' };
  return { root, env, home: env.HOME };
}

const files = {
  '.cursor/rules/style.mdc': '---\ndescription: House style\nalwaysApply: true\n---\nCURSOR-ALWAYS use tabs.',
  '.cursor/rules/react.mdc': '---\ndescription: React rules\nglobs: src/**/*.tsx, *.jsx\nalwaysApply: false\n---\nCURSOR-SCOPED prefer hooks.',
  '.cursor/rules/db.mdc': '---\ndescription: Database migration checklist\nalwaysApply: false\n---\nCURSOR-REQUESTED body.',
  '.cursor/rules/manual.mdc': '---\nalwaysApply: false\n---\nCURSOR-MANUAL body.',
  '.windsurf/rules/always.md': '---\ntrigger: always_on\n---\nWINDSURF-ALWAYS body.',
  '.agent/rules/py.md': '---\ntrigger: glob\nglobs: "**/*.py"\n---\nANTIGRAVITY-SCOPED body.',
  '.agents/rules/deploy.md': '---\ntrigger: model_decision\ndescription: How to deploy\n---\nANTIGRAVITY-REQUESTED body.',
  '.github/instructions/ts.instructions.md': '---\napplyTo: "**/*.ts"\n---\nCOPILOT-SCOPED body.',
  '.github/instructions/all.instructions.md': '---\napplyTo: "**"\n---\nCOPILOT-ALWAYS body.',
  '.kiro/steering/product.md': 'KIRO-ALWAYS body.',
  '.kiro/steering/api.md': '---\ninclusion: fileMatch\nfileMatchPattern: "api/**/*.go"\n---\nKIRO-SCOPED body.',
  '.clinerules/01-basics.md': 'CLINE-ALWAYS body.',
  '.roo/rules/naming.txt': 'ROO-ALWAYS body.'
};

test('rule folders from Cursor, Windsurf, Antigravity, Copilot, Kiro, Cline and Roo load with their triggers', async (t) => {
  const { root, env, home } = await workspace(t, files);
  const text = await loadMemory(root, { env, home });
  for (const marker of ['CURSOR-ALWAYS', 'WINDSURF-ALWAYS', 'COPILOT-ALWAYS', 'KIRO-ALWAYS', 'CLINE-ALWAYS', 'ROO-ALWAYS']) assert.ok(text.includes(marker), marker);
  for (const marker of ['CURSOR-SCOPED', 'CURSOR-REQUESTED', 'CURSOR-MANUAL', 'ANTIGRAVITY-SCOPED', 'ANTIGRAVITY-REQUESTED', 'COPILOT-SCOPED', 'KIRO-SCOPED']) assert.ok(!text.includes(marker), marker);
  assert.match(text, /Rules available on request/);
  assert.match(text, /\.cursor\/rules\/db\.mdc: Database migration checklist/);
  assert.match(text, /\.agents\/rules\/deploy\.md: How to deploy/);
  const modes = Object.fromEntries((await projectRules(root, { env, home })).map((rule) => [rule.label, rule.mode]));
  assert.equal(modes['.cursor/rules/manual.mdc'], 'manual');
  assert.equal(modes['.kiro/steering/api.md'], 'scoped');
});

test('glob-scoped rules load when a matching file is touched', async (t) => {
  const { root, env, home } = await workspace(t, files);
  const loaded = new Set();
  const tsx = (await nestedMemoryFor(root, 'src/ui/App.tsx', loaded, { env, home })).map((item) => item.text).join('\n');
  assert.match(tsx, /CURSOR-SCOPED/);
  assert.doesNotMatch(tsx, /ANTIGRAVITY-SCOPED/);
  const py = (await nestedMemoryFor(root, 'tools/build.py', loaded, { env, home })).map((item) => item.path + ' ' + item.text).join('\n');
  assert.match(py, /\.agent\/rules\/py\.md/);
  assert.match(py, /ANTIGRAVITY-SCOPED/);
  assert.match((await nestedMemoryFor(root, 'api/v1/users.go', loaded, { env, home })).map((item) => item.text).join('\n'), /KIRO-SCOPED/);
  assert.match((await nestedMemoryFor(root, 'lib/x.ts', loaded, { env, home })).map((item) => item.text).join('\n'), /COPILOT-SCOPED/);
});

test('OASIS_OTHER_AGENT_RULES=0 turns other agents\' rule folders off', async (t) => {
  const { root, env, home } = await workspace(t, files);
  const text = await loadMemory(root, { env: { ...env, OASIS_OTHER_AGENT_RULES: '0' }, home });
  assert.doesNotMatch(text, /CURSOR-ALWAYS|CLINE-ALWAYS/);
});
