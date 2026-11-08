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

test('tool servers that did not start reach the app with their reasons', async () => {
  const events = [
    { id: 1, type: 'mcp_failures', data: { servers: [{ name: 'flows', error: 'needs base_url: run oasis plugin config flows base_url=VALUE' }] } },
    { id: 2, type: 'mcp_failures', data: { servers: [] } },
    { id: 3, type: 'completed', data: { text: 'Done.' } }
  ];
  const client = { async api(path) { if (path === '/api/chat') return { jobId: 'j1', sessionId: 's1' }; if (path.startsWith('/api/jobs/j1')) return { status: 'completed', events }; return {}; } };
  const seen = [];
  await new RuntimeAgent({ client, onEvent: (event) => seen.push(event), pollMs: 1 }).send('hi');
  assert.deepEqual(seen.filter((event) => event.type === 'mcp_failures').map((event) => event.servers), [[{ name: 'flows', error: 'needs base_url: run oasis plugin config flows base_url=VALUE' }]]);
});
