import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createSession, closeSession } from '../src/agent.mjs';

// The skill catalogue is resent on every request: built-in skills carry no
// tag, and a deny rule still hides an untagged built-in skill.
test('built-in skills are listed without a tag and deny rules still hide them', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-skill-lean-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-skill-lean-cfg-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(configDir, { recursive: true, force: true }); });
  const env = { ...process.env, OASIS_CONFIG_DIR: configDir, OASIS_SANDBOX: '0' };
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'm', apiKey: 'x' };
  const plain = await createSession({ root, env, config });
  const prompt = String(plain.messages[0].content);
  await closeSession(plain);
  assert.match(prompt, /\n- debugging: /);
  assert.doesNotMatch(prompt, /\[built-in\]/);
  await mkdir(path.join(root, '.oasis'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'settings.json'), JSON.stringify({ permissions: { deny: ['Skill(debugging)'] } }));
  const denied = await createSession({ root, env, config });
  const deniedPrompt = String(denied.messages[0].content);
  await closeSession(denied);
  assert.doesNotMatch(deniedPrompt, /\n- debugging: /);
  assert.match(deniedPrompt, /\n- testing: /);
});
