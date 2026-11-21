import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readFile, utimes, unlink } from 'node:fs/promises';
import { executeTool } from '../src/tools.mjs';
import { externalChangesReminder } from '../src/file-state.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-extchg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_REQUIRE_READ_BEFORE_EDIT: '' };
  const context = { root, env, autoApprove: true, approval: async () => true, session: { config: {} } };
  return { root, context };
}
const bump = (file) => utimes(file, new Date(), new Date(Date.now() + 5000));

test('a small outside change is reported once and the next edit is not refused', async (t) => {
  const { root, context } = await setup(t);
  const file = path.join(root, 'a.js');
  await writeFile(file, 'const a = 1;\nconst b = 2;\n');
  await executeTool('read_file', { path: 'a.js' }, context);
  assert.equal(await externalChangesReminder(context, { root }), '');
  await writeFile(file, 'const a = 1;\nconst b = 3;\n');
  await bump(file);
  const note = await externalChangesReminder(context, { root });
  assert.match(note, /a\.js changed:\nLines 2 now read \(replacing 1 old line\):\n2\| const b = 3;/);
  assert.match(note, /do not revert/);
  assert.equal(await externalChangesReminder(context, { root }), '', 'reported only once');
  await executeTool('edit_file', { path: 'a.js', old_string: 'const b = 3;', new_string: 'const b = 4;' }, context);
  assert.equal(await readFile(file, 'utf8'), 'const a = 1;\nconst b = 4;\n');
  assert.equal(await externalChangesReminder(context, { root }), '', "the agent's own edits are not reported");
});

test('large changes and deletions are named without hunks', async (t) => {
  const { root, context } = await setup(t);
  await writeFile(path.join(root, 'big.txt'), 'x\n');
  await writeFile(path.join(root, 'gone.txt'), 'y\n');
  await executeTool('read_file', { path: 'big.txt' }, context);
  await executeTool('read_file', { path: 'gone.txt' }, context);
  await writeFile(path.join(root, 'big.txt'), Array.from({ length: 300 }, (_, i) => 'row ' + i).join('\n'));
  await bump(path.join(root, 'big.txt'));
  await unlink(path.join(root, 'gone.txt'));
  const note = await externalChangesReminder(context, { root });
  assert.match(note, /big\.txt changed substantially/);
  assert.match(note, /gone\.txt was deleted\./);
  assert.equal(await externalChangesReminder(context, { root }), '');
  // The record stays stale, so an edit still asks for a re-read.
  await assert.rejects(executeTool('edit_file', { path: 'big.txt', old_string: 'row 1\n', new_string: 'r\n' }, context), /modified since it was last read/);
});

test('a turn tells the model about files changed by a command it ran', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-extchg-turn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'note.txt'), 'hello\n');
  await writeFile(path.join(root, 'fmt.mjs'), "import { writeFileSync } from 'node:fs';\nwriteFileSync('note.txt', 'hello world\\n');\n");
  const { config, requests } = await scriptedModel(t, [
    toolCall('r1', 'read_file', { path: 'note.txt' }),
    toolCall('c1', 'run_command', { command: process.execPath, args: ['fmt.mjs'] }),
    { content: 'Done.' }
  ]);
  const session = await createSession({ root, config, settings: { permissions: { allow: [], ask: [], deny: [] } }, bare: true });
  await runAgentTurn(session, 'Format the note.', { approval: async () => true, autoApprove: true });
  const toolMessages = requests[2].messages.filter((message) => message.role === 'tool');
  const last = toolMessages.at(-1);
  assert.match(String(last.content), /note\.txt changed:[\s\S]*1\| hello world/);
});
