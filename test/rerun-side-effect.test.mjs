import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createSession, closeSession, runAgentTurn } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

// Seen live (12 Nov 2026): asked to show `node todo.mjs add milk`, a model ran it
// four times and the list ended with four milks. The second identical run gets a
// reminder that it repeated the command's effect.
async function project(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-rerun-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-rerun-cfg-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(configDir, { recursive: true, force: true }); });
  await writeFile(path.join(root, 'add.mjs'), "import fs from 'node:fs';\nfs.appendFileSync('items.txt', 'milk\\n');\nconsole.log('added');\n");
  return { root, env: { ...process.env, OASIS_CONFIG_DIR: configDir, OASIS_SANDBOX: '0', OASIS_ASSISTED_VERIFICATION: '0' } };
}

const reminder = /already ran this exact command successfully/;
const toolText = (request, id) => JSON.stringify(request.messages.find((m) => m.role === 'tool' && m.tool_call_id === id) || {});

test('re-running a state-changing command with no edit in between gets a reminder', async (t) => {
  const { root, env } = await project(t);
  const { config, requests } = await scriptedModel(t, [
    toolCall('a1', 'run_command', { command: 'node', args: ['add.mjs'] }),
    toolCall('a2', 'run_command', { command: 'node', args: ['add.mjs'] }),
    { content: 'Ran node add.mjs; it printed "added".' }
  ]);
  const session = await createSession({ root, env, config });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'Show me what node add.mjs prints.', { env, autoApprove: true });
  assert.doesNotMatch(toolText(requests[1], 'a1'), reminder);
  assert.match(toolText(requests[2], 'a2'), reminder);
  assert.equal(await readFile(path.join(root, 'items.txt'), 'utf8'), 'milk\nmilk\n');
});

test('read-only commands can be repeated without a reminder', async (t) => {
  const { root, env } = await project(t);
  const { config, requests } = await scriptedModel(t, [
    toolCall('l1', 'run_command', { command: 'ls', args: [] }),
    toolCall('l2', 'run_command', { command: 'ls', args: [] }),
    { content: 'add.mjs is there.' }
  ]);
  const session = await createSession({ root, env, config });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'What files are here?', { env, autoApprove: true });
  assert.doesNotMatch(toolText(requests[2], 'l2'), reminder);
});
