import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { loadMemory, nestedMemoryFor } from '../src/memory.mjs';
import { loadSettings } from '../src/settings.mjs';
import { createSession, closeSession } from '../src/agent.mjs';

async function tmp(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'oasis-mdex-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function repo(t) {
  const parent = await tmp(t);
  const root = path.join(parent, 'monorepo', 'app');
  const home = path.join(parent, 'home');
  await mkdir(path.join(root, '.claude', 'rules'), { recursive: true });
  await mkdir(path.join(root, 'vendor', 'lib'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(parent, 'monorepo', 'CLAUDE.md'), 'PARENT-TEAM-RULE');
  await writeFile(path.join(root, 'CLAUDE.md'), 'APP-RULE');
  await writeFile(path.join(root, '.claude', 'rules', 'style.md'), 'STYLE-RULE');
  await writeFile(path.join(root, 'vendor', 'lib', 'CLAUDE.md'), 'VENDOR-RULE');
  await writeFile(path.join(root, 'vendor', 'lib', 'x.js'), '');
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), OASIS_CONFIG_DIR: home, OASIS_IGNORE_CLAUDE_SETTINGS: '1', OASIS_MANAGED_SETTINGS: '' };
  return { parent, root, home, env };
}

test('claudeMdExcludes skips parent, project and rule files by glob or absolute path', async (t) => {
  const r = await repo(t);
  const all = await loadMemory(r.root, { env: r.env, home: r.home });
  assert.match(all, /PARENT-TEAM-RULE/);
  assert.match(all, /STYLE-RULE/);
  const filtered = await loadMemory(r.root, { env: r.env, home: r.home, excludes: ['**/monorepo/CLAUDE.md', path.join(r.root, '.claude', 'rules') + '/**'] });
  assert.doesNotMatch(filtered, /PARENT-TEAM-RULE/);
  assert.doesNotMatch(filtered, /STYLE-RULE/);
  assert.match(filtered, /APP-RULE/);
});

test('claudeMdExcludes applies to nested CLAUDE.md files loaded on demand', async (t) => {
  const r = await repo(t);
  const loaded = await nestedMemoryFor(r.root, 'vendor/lib/x.js', new Set(), { env: r.env });
  assert.ok(loaded.some((item) => /VENDOR-RULE/.test(item.text)));
  const skipped = await nestedMemoryFor(r.root, 'vendor/lib/x.js', new Set(), { env: r.env, excludes: ['**/vendor/**/CLAUDE.md'] });
  assert.ok(!skipped.some((item) => /VENDOR-RULE/.test(item.text)));
});

test('claudeMdExcludes merges across settings files, including an untrusted project, and reaches the session prompt', async (t) => {
  const r = await repo(t);
  await writeFile(path.join(r.home, 'settings.json'), JSON.stringify({ claudeMdExcludes: ['**/monorepo/CLAUDE.md'] }));
  await writeFile(path.join(r.root, '.claude', 'settings.json'), JSON.stringify({ claudeMdExcludes: ['**/.claude/rules/**'] }));
  const env = { ...r.env };
  delete env.OASIS_TRUST_WORKSPACE;
  const settings = await loadSettings(r.root, { env });
  assert.equal(settings.trusted, false);
  assert.deepEqual(settings.claudeMdExcludes, ['**/monorepo/CLAUDE.md', '**/.claude/rules/**']);
  assert.ok(!settings.ignoredUntrusted.length);
  const session = await createSession({ root: r.root, env, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'x', apiKey: '' } });
  t.after(() => closeSession(session));
  const system = session.messages.find((message) => message.role === 'system').content;
  assert.match(system, /APP-RULE/);
  assert.doesNotMatch(system, /PARENT-TEAM-RULE|STYLE-RULE/);
});
