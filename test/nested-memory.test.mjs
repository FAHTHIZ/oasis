import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { nestedMemoryFor, loadMemory, rulePathMatches } from '../src/memory.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-nested-'));
  await mkdir(path.join(root, 'pkg', 'api'), { recursive: true });
  await writeFile(path.join(root, 'pkg', 'CLAUDE.md'), 'PKG RULE: use tabs');
  await writeFile(path.join(root, 'pkg', 'api', 'AGENTS.md'), 'API RULE: no default exports');
  await writeFile(path.join(root, 'pkg', 'api', 'a.js'), 'export const a = 1;\n');
  await writeFile(path.join(root, 'pkg', 'b.js'), 'b\n');
  return root;
}

test('nestedMemoryFor returns subdirectory instructions once', async () => {
  const root = await fixture();
  const loaded = new Set();
  const first = await nestedMemoryFor(root, 'pkg/api/a.js', loaded);
  assert.deepEqual(first.map((item) => item.path), [path.join('pkg', 'CLAUDE.md'), path.join('pkg', 'api', 'AGENTS.md')]);
  assert.deepEqual(await nestedMemoryFor(root, 'pkg/b.js', loaded), []);
  assert.deepEqual(await nestedMemoryFor(root, '../outside.js', new Set()), []);
  assert.deepEqual(await nestedMemoryFor(root, 'top.js', new Set()), []);
});

test('reading a file attaches that folder\'s CLAUDE.md to the tool result', async (t) => {
  const root = await fixture();
  const { config, requests } = await scriptedModel(t, [
    toolCall('r1', 'read_file', { path: 'pkg/api/a.js' }),
    toolCall('r2', 'read_file', { path: 'pkg/b.js' }),
    { content: 'done' }
  ]);
  const session = await createSession({ root, config, settings, env: { ...process.env, HOME: root } });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'look');
  const tools = requests[2].messages.filter((m) => m.role === 'tool');
  assert.match(tools[0].content, /PKG RULE/);
  assert.match(tools[0].content, /API RULE/);
  assert.doesNotMatch(tools[1].content, /PKG RULE/);
});


test('path-scoped rules are excluded from base memory and loaded only for matching paths', async (t) => {
  const root = await fixture();
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-scoped-home-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(home, { recursive: true, force: true })));
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), OASIS_CONFIG_DIR: path.join(home, '.config', 'oasis'), OASIS_DISABLE_PARENT_MEMORY: '1' };
  await mkdir(path.join(root, '.claude', 'rules'), { recursive: true });
  await writeFile(path.join(root, '.claude', 'rules', 'typescript.md'), '---\npaths: ["pkg/api/**/*.ts", "pkg/api/*.js"]\n---\nSCOPED API RULE: keep compatibility');
  await writeFile(path.join(root, '.claude', 'rules', 'global.md'), 'UNSCOPED RULE: use tests first');
  const base = await loadMemory(root, { env, home });
  assert.match(base, /UNSCOPED RULE/);
  assert.doesNotMatch(base, /SCOPED API RULE/);
  const matched = await nestedMemoryFor(root, 'pkg/api/a.js', new Set(), { env, home });
  assert.ok(matched.some((item) => /SCOPED API RULE/.test(item.text)));
  const nonmatched = await nestedMemoryFor(root, 'pkg/b.js', new Set(), { env, home });
  assert.ok(!nonmatched.some((item) => /SCOPED API RULE/.test(item.text)));
});

test('path-scoped rules support safe glob matching and deterministic conflict ordering', async (t) => {
  assert.equal(rulePathMatches('src/**/*.ts', 'src/app/main.ts'), true);
  assert.equal(rulePathMatches('src/**/*.ts', 'src/main.js'), false);
  assert.equal(rulePathMatches('../secrets/**', 'src/main.ts'), false);
  const root = await fixture();
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-scoped-conflicts-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(home, { recursive: true, force: true })));
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), OASIS_CONFIG_DIR: path.join(home, '.config', 'oasis'), OASIS_DISABLE_PARENT_MEMORY: '1' };
  await mkdir(path.join(home, '.claude', 'rules'), { recursive: true });
  await mkdir(path.join(root, '.claude', 'rules'), { recursive: true });
  await writeFile(path.join(home, '.claude', 'rules', 'base.md'), '---\npaths: ["pkg/**/*.js"]\n---\nUSER BROAD RULE');
  await writeFile(path.join(root, '.claude', 'rules', 'specific.md'), '---\npaths: ["pkg/api/*.js"]\n---\nPROJECT SPECIFIC RULE');
  const rules = await nestedMemoryFor(root, 'pkg/api/a.js', new Set(), { env, home });
  const text = rules.map((item) => item.text).join('\n');
  assert.ok(text.indexOf('USER BROAD RULE') < text.indexOf('PROJECT SPECIFIC RULE'));
});
