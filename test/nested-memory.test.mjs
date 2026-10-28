import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { nestedMemoryFor } from '../src/memory.mjs';
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
