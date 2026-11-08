import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeAgent } from '../app/core/runtime.mjs';

// Seen with gpt-oss in the web app: a streamed reply, then the runtime's
// post-edit check, then the final answer were drawn as one bubble
// ("Provide confirmation.✅ Created…").
test('a verification check after a streamed reply starts a new bubble', async () => {
  const events = [
    { id: 1, type: 'assistant_delta', data: { text: 'Provide confirmation.' } },
    { id: 2, type: 'verification_gate', data: { steps: ['run a check'] } },
    { id: 3, type: 'assistant_delta', data: { text: 'Created index.html.' } },
    { id: 4, type: 'completed', data: { text: 'Created index.html.' } }
  ];
  const client = {
    async api(path) {
      if (path === '/api/chat') return { jobId: 'j1', sessionId: 's1' };
      if (path.startsWith('/api/jobs/j1')) return { status: 'completed', events };
      return {};
    }
  };
  const seen = [];
  const agent = new RuntimeAgent({ client, onEvent: (event) => seen.push(event), pollMs: 1 });
  await agent.send('build it');
  const bubbles = [];
  for (const event of seen) {
    if (event.type === 'thinking') bubbles.push('');
    if (event.type === 'delta') bubbles[bubbles.length - 1] += event.delta;
  }
  const texts = bubbles.filter(Boolean);
  assert.deepEqual(texts, ['Provide confirmation.', 'Created index.html.']);
});
