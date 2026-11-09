import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeAgent } from '../app/core/runtime.mjs';

const JOB = '0f1e2d3c-4b5a-4968-8776-655443322110';

function fakeClient(pages) {
  const calls = [];
  let poll = 0;
  return {
    calls,
    async api(path, options = {}) {
      calls.push({ path, body: options.body });
      if (path.startsWith('/api/jobs/' + JOB + '?after=' + Number.MAX_SAFE_INTEGER)) return { status: pages[0].status, events: [] };
      if (path.startsWith('/api/jobs/' + JOB + '?after=')) {
        const after = Number.parseInt(path.split('after=')[1], 10);
        const page = pages[Math.min(poll++, pages.length - 1)];
        return { status: page.status, events: page.events.filter((event) => event.id > after) };
      }
      return {};
    }
  };
}

test('a saved running job is offered for resume and replays its timeline', async () => {
  const events = [
    { id: 1, type: 'started', data: { sessionId: 's1' } },
    { id: 2, type: 'assistant_text', data: { text: 'Looking at the code.' } },
    { id: 3, type: 'tool_start', data: { callId: 'c1', name: 'run_command', args: { command: 'npm test' } } },
    { id: 4, type: 'approval_required', data: { approvalId: 'a1', prompt: 'Run npm test?' } },
    { id: 5, type: 'approval_resolved', data: { approvalId: 'a1', approved: true } },
    { id: 6, type: 'tool_result', data: { callId: 'c1', name: 'run_command', status: 'ok', result: '1 passed' } },
    { id: 7, type: 'tool_start', data: { callId: 'c2', name: 'run_command', args: { command: 'git push' } } },
    { id: 8, type: 'approval_required', data: { approvalId: 'a2', prompt: 'Push?' } }
  ];
  const finished = [...events,
    { id: 9, type: 'approval_resolved', data: { approvalId: 'a2', approved: false } },
    { id: 10, type: 'tool_result', data: { callId: 'c2', name: 'run_command', status: 'denied', result: 'declined' } },
    { id: 11, type: 'completed', data: { text: 'Tests pass; push skipped.' } }];
  const client = fakeClient([{ status: 'waiting_approval', events }, { status: 'completed', events: finished }]);
  const asked = [];
  const seen = [];
  const agent = new RuntimeAgent({ client, pollMs: 1, onEvent: (event) => seen.push(event), approve: async (request) => { asked.push(request.args.prompt); return false; } });
  agent.load({ sessionId: 's1', jobId: JOB });
  assert.equal(agent.resumeJobId, JOB);
  assert.equal(await agent.jobStatus(JOB), 'waiting_approval');
  await agent.resume(JOB);
  assert.deepEqual(asked, ['Push?'], 'the answered approval is not asked again; the open one is');
  const approvals = client.calls.filter((call) => call.path.endsWith('/approval'));
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].body.approvalId, 'a2');
  const types = seen.map((event) => event.type);
  assert.equal(types[0], 'resumed');
  assert.ok(!types.includes('user'), 'resuming does not repeat the user message');
  assert.equal(seen.filter((event) => event.type === 'tool_start').length, 2);
  assert.equal(types.at(-1), 'done');
  assert.equal(agent.busy, false);
  assert.equal(agent.resumeJobId, '');
});

test('a finished job replays without asking for its stale approvals', async () => {
  const events = [
    { id: 1, type: 'approval_required', data: { approvalId: 'a1', prompt: 'Run?' } },
    { id: 2, type: 'completed', data: { text: 'Done.' } }
  ];
  const client = fakeClient([{ status: 'interrupted', events }]);
  const asked = [];
  const agent = new RuntimeAgent({ client, pollMs: 1, approve: async () => { asked.push(1); return true; } });
  await agent.resume(JOB);
  assert.equal(asked.length, 0);
});

test('only running agent jobs are saved for resume, and bad ids are ignored', () => {
  const agent = new RuntimeAgent({ client: { api: async () => ({}) } });
  agent.busy = true; agent.jobId = JOB; agent.jobKind = 'agent';
  assert.equal(agent.snapshot().jobId, JOB);
  agent.jobKind = '';
  assert.equal(agent.snapshot().jobId, undefined);
  agent.load({ jobId: '../../etc' });
  assert.equal(agent.resumeJobId, '');
});

test('detaching leaves the task running: no denial is posted and it resumes later', async () => {
  const events = [
    { id: 1, type: 'started', data: { sessionId: 's1' } },
    { id: 2, type: 'approval_required', data: { approvalId: 'a1', prompt: 'Run npm test?' } }
  ];
  const posted = [];
  const client = {
    async api(path, options = {}) {
      if (path === '/api/chat') return { jobId: JOB, sessionId: 's1' };
      if (path.endsWith('/approval') || path.endsWith('/cancel')) { posted.push(path); return {}; }
      if (path.startsWith('/api/jobs/' + JOB)) return { status: 'waiting_approval', events: events.filter((e) => e.id > Number.parseInt(path.split('after=')[1], 10)) };
      return {};
    }
  };
  const seen = [];
  let release;
  const agent = new RuntimeAgent({
    client, pollMs: 1, onEvent: (event) => seen.push(event.type),
    approve: () => new Promise((resolve) => { release = resolve; })
  });
  const running = agent.send('fix it');
  while (!release) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(agent.snapshot().jobId, JOB, 'the running job is saved before leaving');
  assert.equal(agent.detach(), JOB);
  release(false); // the sheet closing resolves the prompt as "no"
  await running;
  assert.deepEqual(posted, [], 'leaving the chat neither denies the approval nor cancels the task');
  assert.equal(seen.at(-1), 'detached');
  assert.ok(!seen.includes('done') && !seen.includes('stopped'));
  assert.equal(agent.busy, false);
  assert.equal(agent.detach(), '', 'nothing to detach when idle');
});
