import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeAgent } from '../app/core/runtime.mjs';

// /api/chat answers 409 when another task holds the folder. The page needs the
// task it names (to open or stop it) and the request that was turned away.
const HOLDER = { id: '0f1e2d3c-4b5a-4968-8776-655443322110', type: 'agent', title: 'Explain slug.mjs', sessionId: 's-other', status: 'running' };

function rejectingClient(data, status = 409) {
  return {
    async api(path) {
      if (path === '/api/chat') throw Object.assign(new Error(data.error), { status, data });
      return {};
    }
  };
}

test('a busy folder error carries the running task and the request', async () => {
  const seen = [];
  const agent = new RuntimeAgent({ client: rejectingClient({ error: 'OASIS is still working on "Explain slug.mjs" in this folder.', activeJob: HOLDER }), pollMs: 1, onEvent: (event) => seen.push(event) });
  await agent.send('  Add a README.md  ');
  const error = seen.find((event) => event.type === 'error');
  assert.ok(error, 'an error event is emitted');
  assert.match(error.message, /still working on "Explain slug\.mjs"/);
  assert.deepEqual(error.activeJob, HOLDER);
  assert.equal(error.request, 'Add a README.md', 'the original request, without carried terminal output');
  assert.equal(seen.at(-1).type, 'done');
  assert.equal(agent.busy, false);
});

test('other errors do not offer to open or stop a task', async () => {
  for (const [data, status] of [[{ error: 'Message is too long.' }, 413], [{ error: 'Busy', activeJob: { title: 'no id' } }, 409], [{ error: 'Odd', activeJob: HOLDER }, 500]]) {
    const seen = [];
    const agent = new RuntimeAgent({ client: rejectingClient(data, status), pollMs: 1, onEvent: (event) => seen.push(event) });
    await agent.send('hello');
    const error = seen.find((event) => event.type === 'error');
    assert.equal(error.activeJob, undefined, JSON.stringify(data) + ' ' + status);
    assert.equal(error.request, undefined);
  }
});
