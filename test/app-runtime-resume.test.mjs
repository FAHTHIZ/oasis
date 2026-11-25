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

test('an approval answered on another device closes here and is not posted again', async () => {
  const events = [
    { id: 1, type: 'started', data: { sessionId: 's1' } },
    { id: 2, type: 'tool_start', data: { callId: 'c1', name: 'run_command', args: { command: 'npm test' } } },
    { id: 3, type: 'approval_required', data: { approvalId: 'a1', prompt: 'Run npm test?' } }
  ];
  const later = [...events,
    { id: 4, type: 'approval_resolved', data: { approvalId: 'a1', approved: true } },
    { id: 5, type: 'tool_result', data: { callId: 'c1', name: 'run_command', status: 'ok', result: '1 passed' } },
    { id: 6, type: 'completed', data: { text: 'Done.' } }];
  let answeredElsewhere = false;
  const calls = [];
  const client = {
    async api(path, options = {}) {
      calls.push({ path, body: options.body });
      const after = Number.parseInt(path.split('after=')[1], 10) || 0;
      if (after === Number.MAX_SAFE_INTEGER) return { status: 'waiting_approval', events: [] };
      // The other device answers once this page is showing the approval.
      const list = answeredElsewhere ? later : events;
      return { status: answeredElsewhere ? 'completed' : 'waiting_approval', events: list.filter((event) => event.id > after) };
    }
  };
  const seen = [];
  const agent = new RuntimeAgent({ client, pollMs: 1, waitMs: 1, onEvent: (event) => seen.push(event), approve: () => { setTimeout(() => { answeredElsewhere = true; }, 20); return new Promise(() => {}); } });
  await agent.resume(JOB);
  assert.equal(calls.filter((call) => call.path.endsWith('/approval')).length, 0, 'nothing is posted for an approval answered elsewhere');
  const types = seen.map((event) => event.type);
  assert.ok(types.includes('answered_elsewhere'));
  assert.equal(seen.find((event) => event.type === 'answered_elsewhere').kind, 'approval');
  assert.ok(seen.some((event) => event.type === 'tool_result' && event.ok));
  assert.equal(types.at(-1), 'done');
});

test('a replayed step leaves its approval wait out of its time, as the live view does', async () => {
  const t = (s) => new Date(Date.UTC(2026, 10, 25, 10, 0, s)).toISOString();
  const events = [
    { id: 1, type: 'tool_start', at: t(0), data: { callId: 'c1', name: 'mcp_x_read', args: {} } },
    { id: 2, type: 'approval_required', at: t(1), data: { approvalId: 'a1', prompt: 'Run?' } },
    { id: 3, type: 'approval_resolved', at: t(50), data: { approvalId: 'a1', approved: true } },
    // An older server: durationMs counts the wait and no waitedMs is sent.
    { id: 4, type: 'tool_result', at: t(51), data: { callId: 'c1', name: 'mcp_x_read', status: 'ok', result: 'done', durationMs: 51000 } },
    { id: 5, type: 'tool_start', at: t(52), data: { callId: 'c2', name: 'mcp_x_read', args: {} } },
    { id: 6, type: 'tool_result', at: t(53), data: { callId: 'c2', name: 'mcp_x_read', status: 'ok', result: 'done', durationMs: 1000, waitedMs: 0 } },
    { id: 7, type: 'completed', data: { text: 'Done.' } }
  ];
  const client = fakeClient([{ status: 'completed', events }]);
  const seen = [];
  const agent = new RuntimeAgent({ client, pollMs: 1, onEvent: (event) => seen.push(event), approve: async () => true });
  await agent.resume(JOB);
  const results = seen.filter((event) => event.type === 'tool_result');
  assert.equal(results[0].durationMs, 51000);
  assert.equal(results[0].waitedMs, 49000);
  assert.equal(results[1].waitedMs, undefined, 'a step with no approval has no wait');
});

test('waitedDuring and approvalWaitWithin count only the overlap with the step', async () => {
  const { waitedDuring } = await import('../src/web.mjs');
  const { approvalWaitWithin } = await import('../app/core/runtime.mjs');
  for (const fn of [waitedDuring, approvalWaitWithin]) {
    assert.equal(fn([[10, 40]], 0, 100), 30);
    assert.equal(fn([[10, 40], [200, 300]], 0, 100), 30, 'a later approval is not counted');
    assert.equal(fn([[0, 500]], 100, 200), 100, 'never more than the step itself');
    assert.equal(fn([], 0, 100), 0);
  }
});

test('replayed events that end a thought carry the time they happened', async () => {
  const t = (s) => new Date(Date.UTC(2026, 10, 25, 10, 0, s)).toISOString();
  const events = [
    { id: 1, type: 'reasoning_delta', at: t(1), data: { text: 'Planning.' } },
    { id: 2, type: 'tool_draft', at: t(3), data: { index: 0, name: 'read_file', chars: 10 } },
    { id: 3, type: 'tool_start', at: t(4), data: { callId: 'c1', name: 'read_file', args: { path: 'a' } } },
    { id: 4, type: 'approval_required', at: t(5), data: { approvalId: 'a1', prompt: 'Run?' } }
  ];
  const client = fakeClient([{ status: 'waiting_approval', events }]);
  const seen = [];
  const agent = new RuntimeAgent({ client, pollMs: 1, onEvent: (event) => { seen.push(event); if (event.type === 'tool_start') agent.stop?.(); }, approve: () => new Promise(() => {}) });
  agent.resume(JOB).catch(() => {});
  for (let i = 0; i < 50 && !seen.some((event) => event.type === 'tool_start'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  const draft = seen.find((event) => event.type === 'tool_draft');
  const assistant = seen.find((event) => event.type === 'assistant');
  assert.ok(Number.isFinite(draft.at) && Math.abs(draft.at - Date.parse(t(3))) < 60_000, 'tool_draft has its own time');
  assert.ok(Number.isFinite(assistant.at), 'the assistant turn before a step has its time');
});
