// A custom agent file over 64 KiB still loads, and a prompt past the
// prompt limit ends with a note instead of stopping mid-sentence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadAgentDefinitions } from '../src/subagents.mjs';

test('large agent files load', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-agent-size-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, '.claude', 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'big.md'), '---\nname: big\ndescription: A big agent\n---\n' + 'Rule line.\n'.repeat(10000) + 'LAST RULE');
  await writeFile(path.join(dir, 'huge.md'), '---\nname: huge\ndescription: A huge agent\n---\n' + 'x'.repeat(300000));
  const env = { HOME: root, OASIS_CONFIG_DIR: path.join(root, 'cfg'), OASIS_TRUST_WORKSPACE: '1' };
  const agents = await loadAgentDefinitions(root, { env });
  assert.ok(agents.big, 'a 110 KB agent file loads');
  assert.match(agents.big.prompt, /LAST RULE$/);
  assert.ok(agents.huge);
  assert.match(agents.huge.prompt, /\[Agent prompt cut: 100,000 more characters are in the agent file\.\]$/);
});
