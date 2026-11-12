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

const scripted = (events) => ({ async api(path) { if (path === '/api/chat') return { jobId: 'j1', sessionId: 's1' }; if (path.startsWith('/api/jobs/j1')) return { status: 'completed', events }; return {}; } });

test('a tool call a small model wrote as JSON text does not stay in the transcript once it runs', async () => {
  const json = '{\n  "name": "write_file",\n  "arguments": {\n    "path": "index.html",\n    "content": "<!DOCTYPE html>"\n  }\n}';
  const events = [
    { id: 1, type: 'assistant_delta', data: { text: json } },
    { id: 2, type: 'tool_start', data: { callId: 'c1', name: 'write_file', args: { path: 'index.html' } } },
    { id: 3, type: 'tool_result', data: { callId: 'c1', name: 'write_file', status: 'ok', output: 'Wrote index.html' } },
    { id: 4, type: 'completed', data: { text: 'Created index.html.' } }
  ];
  const seen = [];
  await new RuntimeAgent({ client: scripted(events), onEvent: (event) => seen.push(event), pollMs: 1 }).send('build it');
  const withCall = seen.find((event) => event.type === 'assistant' && event.toolCalls && event.toolCalls.length);
  assert.equal(withCall.content, '');
  // Ordinary prose before a real call is kept.
  const prose = [{ id: 1, type: 'assistant_delta', data: { text: 'Writing the page now.' } }, ...events.slice(1)];
  const seen2 = [];
  await new RuntimeAgent({ client: scripted(prose), onEvent: (event) => seen2.push(event), pollMs: 1 }).send('build it');
  assert.equal(seen2.find((event) => event.type === 'assistant' && event.toolCalls && event.toolCalls.length).content, 'Writing the page now.');
});
