import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { completeExchanges, saveSession, loadSession } from '../src/sessions.mjs';

const call = (id) => ({ id, type: 'function', function: { name: 'read_file', arguments: '{}' } });

test('completeExchanges drops a tool call whose results have not all arrived', () => {
  const base = [{ role: 'system', content: 's' }, { role: 'user', content: 'fix it' }];
  const done = [...base, { role: 'assistant', content: '', tool_calls: [call('a')] }, { role: 'tool', tool_call_id: 'a', content: 'ok' }];
  assert.deepEqual(completeExchanges(done), done);
  const pending = [...done, { role: 'assistant', content: '', tool_calls: [call('b'), call('c')] }, { role: 'tool', tool_call_id: 'b', content: 'ok' }];
  assert.deepEqual(completeExchanges(pending), done);
  assert.deepEqual(completeExchanges(base), base);
});

// A turn interrupted mid-task (closed terminal, crash) is saved as it goes and
// resumes without a dangling tool call the provider would reject.
test('a session saved mid-turn loads back as a valid transcript', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-midturn-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(dir, 'cfg') };
  const session = { root: dir, config: { model: 'm' }, messages: [
    { role: 'system', content: 's' }, { role: 'user', content: 'fix it' },
    { role: 'assistant', content: '', tool_calls: [call('a')] }, { role: 'tool', tool_call_id: 'a', content: 'ok' },
    { role: 'assistant', content: '', tool_calls: [call('b')] }
  ] };
  const saved = await saveSession(session, { env });
  const loaded = await loadSession(dir, saved.id, { env });
  const messages = loaded.messages || loaded.session?.messages;
  assert.equal(messages.at(-1).role, 'tool');
  assert.equal(messages.length, 4);
});
