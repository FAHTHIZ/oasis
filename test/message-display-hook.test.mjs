import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

test('MessageDisplay hooks rewrite displayed text only', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-md-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen = path.join(root, 'seen.json');
  const script = path.join(root, 'hook.mjs');
  await writeFile(script, "import { writeFileSync } from 'node:fs';\nlet s = '';\nprocess.stdin.on('data', (d) => { s += d; }).on('end', () => { writeFileSync(" + JSON.stringify(seen) + ", s); const p = JSON.parse(s); process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'MessageDisplay', displayContent: p.delta.replace(/secret-\\w+/g, '[redacted]') } })); });\n");
  const { config, requests } = await scriptedModel(t, [{ content: 'The token is secret-abc123.' }, { content: 'next' }]);
  const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, sandbox: { enabled: false }, shell: { enabled: false },
    hooks: { MessageDisplay: [{ hooks: [{ type: 'command', command: JSON.stringify(process.execPath) + ' ' + JSON.stringify(script) }] }] } };
  const session = await createSession({ root, config, settings });
  t.after(() => closeSession(session));
  const shown = [];
  const result = await runAgentTurn(session, 'what is the token', { onText: (text) => shown.push(text) });
  assert.deepEqual(shown, ['The token is [redacted].']);
  assert.equal(result.text, 'The token is secret-abc123.');
  assert.ok(session.messages.some((m) => m.role === 'assistant' && m.content === 'The token is secret-abc123.'));
  const input = JSON.parse(await readFile(seen, 'utf8'));
  assert.equal(input.hook_event_name, 'MessageDisplay');
  assert.equal(input.index, 0);
  assert.equal(input.final, true);
  assert.match(input.turn_id, /^[0-9a-f-]{36}$/);
  assert.match(input.message_id, /^[0-9a-f-]{36}$/);
  assert.ok(requests.length >= 1);
});
