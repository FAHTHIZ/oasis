import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { agentRegistry, registerAgent, sendTeamMessage, drainInbox, createAgentTeam, listAgentTeams, shutdownAgentTeam, AGENT_TOOL_NAMES, agentEvents, recordAgentEvent, summarizeAgent, stopAgent } from '../src/agent-tasks.mjs';
import { runSharedTaskTool } from '../src/shared-tasks.mjs';
import { isCommitIntegrated } from '../src/worktrees.mjs';

// These scripted fixtures overwrite files without reading them first; read-before-edit
// enforcement is covered by test/file-state.test.mjs.
process.env.OASIS_REQUIRE_READ_BEFORE_EDIT = '0';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const text = (messages) => messages.map((m) => typeof m.content === 'string' ? m.content : '').join('\n');

// A model server: `parent` and `child` are functions (payload, index) => message, possibly async.
async function modelServer(t, { parent, child }) {
  const parentRequests = [];
  const childRequests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const isChild = payload.messages[0].content.includes('SUBAGENT MODE');
    const list = isChild ? childRequests : parentRequests;
    list.push(payload);
    const message = await (isChild ? child : parent)(payload, list.length);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 8, maxCommandSeconds: 10 };
  return { config, parentRequests, childRequests };
}

function gate() { let open; const promise = new Promise((resolve) => { open = resolve; }); return { promise, open }; }
async function until(check, ms = 5000) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
}

test('background task returns at once, reports back on the next turn, and can be resumed with context', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-bg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = gate();
  let parentTurn = 0;
  const { config, parentRequests, childRequests } = await modelServer(t, {
    parent: (payload) => {
      const last = payload.messages[payload.messages.length - 1];
      if (last.role === 'user' && last.content.startsWith('start')) return { content: null, tool_calls: [call('t1', 'task', { description: 'audit deps', prompt: 'audit the dependencies', subagent_type: 'explore', run_in_background: true })] };
      if (last.role === 'user' && last.content.startsWith('follow')) return { content: null, tool_calls: [call('s1', 'send_message', { id: 'agent_1', message: 'now check licenses too' })] };
      parentTurn++;
      return { content: 'parent reply ' + parentTurn };
    },
    child: async (payload) => {
      if (text(payload.messages).includes('check licenses')) return { content: 'LICENSES OK (I remember: audited deps)' };
      await release.promise;
      return { content: 'DEPS REPORT: 3 outdated' };
    }
  });
  const session = await createSession({ root, config, settings });
  t.after(() => closeSession(session));
  const notices = [];
  session.onAgentNotice = (notice) => notices.push(notice);
  const first = await runAgentTurn(session, 'start the audit');
  assert.equal(first.text, 'parent reply 1');
  const launched = parentRequests[1].messages.find((m) => m.role === 'tool');
  assert.match(launched.content, /"id":"agent_1"/);
  assert.match(launched.content, /"status":"running"/);
  const listing = await runBuiltinCommand('tasks', '', { root, session });
  assert.match(listing.output, /agent_1\s+running\s+bg explore: audit deps/);
  release.open();
  await until(() => notices.length === 1);
  assert.match(notices[0], /agent_1.*finished/);
  const detail = await runBuiltinCommand('tasks', 'agent_1', { root, session });
  assert.match(detail.output, /DEPS REPORT/);
  await runAgentTurn(session, 'anything new?');
  const turnTwo = parentRequests[parentRequests.length - 1];
  const userText = turnTwo.messages.filter((m) => m.role === 'user').pop().content;
  assert.match(userText, /Background agent agent_1 \("audit deps"\) finished/);
  assert.match(userText, /DEPS REPORT: 3 outdated/);
  // Resume the finished agent: it keeps its earlier conversation.
  await runAgentTurn(session, 'follow up with the agent');
  await until(() => session.agentTasks.agents.get('agent_1').status === 'completed' && session.agentTasks.agents.get('agent_1').runs === 2);
  const resumed = childRequests[childRequests.length - 1];
  assert.match(text(resumed.messages), /DEPS REPORT: 3 outdated/, 'previous context is kept');
  assert.match(text(resumed.messages), /now check licenses too/);
  assert.equal(session.agentTasks.agents.get('agent_1').report, 'LICENSES OK (I remember: audited deps)');
});

test('send_message steers a running agent, agent_status waits, and agent_stop cancels', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-bg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.txt'), 'hello');
  const firstStep = gate();
  const hang = gate();
  const { config, parentRequests, childRequests } = await modelServer(t, {
    parent: (payload) => {
      const last = payload.messages[payload.messages.length - 1];
      if (last.role === 'user' && last.content.startsWith('go')) return { content: null, tool_calls: [
        call('t1', 'task', { description: 'reader', prompt: 'read a.txt', subagent_type: 'explore', run_in_background: true }),
        call('t2', 'task', { description: 'sleeper', prompt: 'sleep forever', subagent_type: 'explore', run_in_background: true })
      ] };
      if (last.role === 'tool' && last.content.includes('"delivered"')) return { content: null, tool_calls: [call('w1', 'agent_status', { id: 'agent_1', wait_seconds: 20 })] };
      if (last.role === 'tool' && last.content.includes('"report"')) return { content: null, tool_calls: [call('x1', 'agent_stop', { id: 'agent_2' })] };
      if (last.role === 'tool' && last.content.includes('stopping')) return { content: 'all done' };
      if (last.role === 'user' && last.content.startsWith('steer')) return { content: null, tool_calls: [call('m1', 'send_message', { id: 'agent_1', message: 'ALSO COUNT THE LETTERS' })] };
      return { content: 'ok' };
    },
    child: async (payload) => {
      const all = text(payload.messages);
      if (all.includes('sleep forever')) { await hang.promise; return { content: 'never' }; }
      if (!payload.messages.some((m) => m.role === 'tool')) { await firstStep.promise; return { content: null, tool_calls: [call('r1', 'read_file', { path: 'a.txt' })] }; }
      return { content: all.includes('ALSO COUNT THE LETTERS') ? 'read hello, 5 letters' : 'read hello' };
    }
  });
  const session = await createSession({ root, config, settings });
  t.after(() => { hang.open(); closeSession(session); });
  await runAgentTurn(session, 'go');
  assert.equal(session.agentTasks.agents.size, 2);
  // While agent_1 is still on its first step, queue a message; it arrives at the next step.
  const steering = runAgentTurn(session, 'steer agent one');
  await until(() => parentRequests.some((p) => text(p.messages).includes('"delivered":"queued"')) || parentRequests.length > 6);
  firstStep.open();
  const final = await steering;
  assert.equal(final.text, 'all done');
  const agent1 = session.agentTasks.agents.get('agent_1');
  assert.equal(agent1.status, 'completed');
  assert.equal(agent1.report, 'read hello, 5 letters');
  const stepTwo = childRequests.find((p) => text(p.messages).includes('ALSO COUNT THE LETTERS'));
  assert.ok(stepTwo, 'child saw the steering message');
  await until(() => session.agentTasks.agents.get('agent_2').status === 'cancelled');
  // The finish notice for agent_1 was already read via agent_status, so it is not repeated.
  await runAgentTurn(session, 'anything else');
  const lastUser = parentRequests[parentRequests.length - 1].messages.filter((m) => m.role === 'user').pop().content;
  assert.ok(!lastUser.includes('agent_1 ("reader") finished'), 'no duplicate notice for a report already read');
  assert.ok(parentRequests.some((p) => /agent_2 \("sleeper"\) cancelled/.test(text(p.messages))), 'cancellation is reported to the parent');
});

test('background agents cannot prompt: unapproved actions are denied', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-bg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let prompts = 0;
  const { config, childRequests } = await modelServer(t, {
    parent: (payload) => {
      const last = payload.messages[payload.messages.length - 1];
      if (last.role === 'user' && last.content.startsWith('write')) return { content: null, tool_calls: [call('t1', 'task', { description: 'writer', prompt: 'write a file', run_in_background: true })] };
      return { content: 'ok' };
    },
    child: (payload) => payload.messages.some((m) => m.role === 'tool')
      ? { content: 'tried' }
      : { content: null, tool_calls: [call('w1', 'run_command', { command: process.execPath, args: ['-e', 'require("fs").writeFileSync("made.txt","x")'] })] }
  });
  const session = await createSession({ root, config, settings });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'write something', { approval: async () => { prompts++; return true; } });
  await until(() => session.agentTasks.agents.get('agent_1').status !== 'running');
  assert.equal(prompts, 0, 'the user was never prompted');
  await assert.rejects(access(path.join(root, 'made.txt')));
  const toolResult = childRequests[1].messages.find((m) => m.role === 'tool').content;
  assert.match(toolResult, /not approved|denied/i);
});

test('team messages reach running peer inboxes without enabling parent-only agent controls', () => {
  const main = {};
  const registry = agentRegistry(main);
  const sender = registerAgent(main, { type: 'general-purpose', description: 'API designer', child: { inbox: [] } });
  const receiver = registerAgent(main, { type: 'general-purpose', description: 'test specialist', child: { inbox: [] } });
  const senderSession = { agentTasks: registry, agentId: sender.id };
  const sent = sendTeamMessage(senderSession, { to: receiver.id, message: 'Use the same response envelope and add a regression test.' });
  assert.equal(sent.delivered, 'queued');
  assert.equal(sent.from, sender.id);
  assert.equal(sent.to, receiver.id);
  assert.match(drainInbox(receiver.child), /Direct message from teammate agent_1/);
  assert.match(drainInbox(receiver.child), /^$/);
  assert.throws(() => sendTeamMessage(senderSession, { to: sender.id, message: 'self' }), /itself/);
  receiver.status = 'completed';
  assert.throws(() => sendTeamMessage(senderSession, { to: receiver.id, message: 'too late' }), /not running/);
});

test('background teammates can message each other and deliver messages into the next model step', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-team-message-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const senderRelease = gate();
  const receiverRelease = gate();
  const senderEntered = gate();
  const receiverEntered = gate();
  const { config, childRequests } = await modelServer(t, {
    parent: (payload) => {
      const last = payload.messages[payload.messages.length - 1];
      if (last.role === 'user' && last.content === 'launch sender') {
        return { content: null, tool_calls: [call('start-sender', 'task', { description: 'sender', prompt: 'SENDER_ROLE: message agent_2 after it has started.', run_in_background: true })] };
      }
      if (last.role === 'user' && last.content === 'launch receiver') {
        return { content: null, tool_calls: [call('start-receiver', 'task', { description: 'receiver', prompt: 'RECEIVER_ROLE: wait for a teammate message, then inspect the task board.', run_in_background: true })] };
      }
      return { content: 'parent turn finished' };
    },
    child: async (payload) => {
      const all = text(payload.messages);
      if (all.includes('SENDER_ROLE')) {
        if (payload.messages.some((message) => message.role === 'tool')) return { content: 'sender delivered the peer message' };
        senderEntered.open();
        await senderRelease.promise;
        return { content: null, tool_calls: [call('peer-message', 'team_send_message', { to: 'agent_2', message: 'Please check task_1 and report the API field names.' })] };
      }
      if (all.includes('RECEIVER_ROLE')) {
        if (payload.messages.some((message) => message.role === 'tool') && all.includes('Direct message from teammate agent_1')) {
          assert.match(all, /Please check task_1 and report the API field names/);
          return { content: 'recipient received the direct message and continued its task' };
        }
        receiverEntered.open();
        await receiverRelease.promise;
        return { content: null, tool_calls: [call('receiver-list', 'task_list', {})] };
      }
      return { content: 'Unexpected teammate prompt.' };
    }
  });
  const session = await createSession({ root, config, settings });
  t.after(() => closeSession(session));

  assert.equal((await runAgentTurn(session, 'launch sender')).text, 'parent turn finished');
  await senderEntered.promise;
  assert.equal((await runAgentTurn(session, 'launch receiver')).text, 'parent turn finished');
  await receiverEntered.promise;
  senderRelease.open();

  await until(() => session.agentTasks.agents.get('agent_2')?.child?.inbox?.some((entry) => entry.kind === 'peer-message'));
  assert.ok(childRequests.some((request) => request.tools.some((tool) => tool.function.name === 'team_send_message')));
  receiverRelease.open();
  await until(() => ['agent_1', 'agent_2'].every((id) => session.agentTasks.agents.get(id)?.status !== 'running'));
  assert.match(session.agentTasks.agents.get('agent_2').report, /received the direct message/);
});

test('subagents cannot manage other agents', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-bg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config, childRequests } = await modelServer(t, {
    parent: (payload) => payload.messages.some((m) => m.role === 'tool') ? { content: 'done' } : { content: null, tool_calls: [call('t1', 'task', { description: 'x', prompt: 'do x' })] },
    child: () => ({ content: 'child done' })
  });
  const session = await createSession({ root, config, settings });
  t.after(() => closeSession(session));
  assert.ok(session.toolDefinitions.some((d) => d.function.name === 'send_message'));
  await runAgentTurn(session, 'delegate');
  const names = childRequests[0].tools.map((tool) => tool.function.name);
  for (const name of ['task', 'agent_status', 'send_message', 'agent_stop']) assert.ok(!names.includes(name), name);
  assert.ok(names.includes('team_send_message'), 'subagents can message peers without managing their lifecycle');
  assert.equal(session.agentTasks.agents.get('agent_1').status, 'completed', 'foreground agents are registered too');
});


test('named teams track membership, isolate peer messages, and shut down safely', () => {
  const main = {};
  const created = createAgentTeam(main, { name: 'API Design', description: 'Agree on the response contract' });
  assert.equal(created.team.id, 'team_1');
  assert.equal(created.team.status, 'active');
  assert.ok(AGENT_TOOL_NAMES.has('team_create'));
  assert.ok(AGENT_TOOL_NAMES.has('team_status'));
  assert.ok(AGENT_TOOL_NAMES.has('team_shutdown'));
  assert.ok(AGENT_TOOL_NAMES.has('agent_events'));

  const sameTeam = registerAgent(main, {
    type: 'general-purpose', description: 'API designer', teamId: created.team.id,
    child: { inbox: [] }, controller: new AbortController()
  });
  const otherTeam = createAgentTeam(main, { name: 'Docs Review' });
  const outsider = registerAgent(main, {
    type: 'general-purpose', description: 'Docs reviewer', teamId: otherTeam.team.id,
    child: { inbox: [] }
  });
  assert.equal(listAgentTeams(main)[0].members[0].id, sameTeam.id);
  assert.equal(sameTeam.teamId, created.team.id);
  assert.throws(() => sendTeamMessage({ agentTasks: main.agentTasks, agentId: sameTeam.id }, { to: outsider.id, message: 'cross-team' }), /same team/);

  const teammate = registerAgent(main, {
    type: 'general-purpose', description: 'API tester', teamId: created.team.id,
    child: { inbox: [] }
  });
  const sent = sendTeamMessage({ agentTasks: main.agentTasks, agentId: sameTeam.id }, { to: teammate.id, message: 'Use the same response envelope.' });
  assert.equal(sent.delivered, 'queued');
  assert.match(teammate.child.inbox[0].text, /same response envelope/);

  const stopped = shutdownAgentTeam(main, { team_id: created.team.id });
  assert.equal(stopped.team.status, 'shutting_down');
  assert.equal(stopped.stop_requested, 2);
  assert.equal(sameTeam.controller.signal.aborted, true);
  assert.throws(() => registerAgent(main, { type: 'general-purpose', description: 'late worker', teamId: created.team.id, child: { inbox: [] } }), /shutting_down/);

  sameTeam.status = 'cancelled';
  teammate.status = 'cancelled';
  assert.equal(listAgentTeams(main).find((team) => team.id === created.team.id).status, 'closed');
});

test('the task tool launches a registered worker into its named team', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-team-launch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config } = await modelServer(t, {
    parent: (payload) => {
      const last = payload.messages[payload.messages.length - 1];
      if (last.role === 'user' && last.content === 'create team') return { content: null, tool_calls: [call('tc', 'team_create', { name: 'Review Team' })] };
      if (last.role === 'user' && last.content === 'launch member') return { content: null, tool_calls: [call('launch', 'task', { description: 'team member', prompt: 'Report the team assignment.', team_id: 'team_1' })] };
      return { content: 'done' };
    },
    child: () => ({ content: 'team worker complete' })
  });
  const session = await createSession({ root, config, settings });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'create team');
  await runAgentTurn(session, 'launch member');
  assert.equal(session.agentTasks.agents.get('agent_1').teamId, 'team_1');
  assert.deepEqual(session.agentTasks.teams.get('team_1').members, ['agent_1']);
  assert.match((await runBuiltinCommand('teams', '', { root, session, env: process.env })).output, /Review Team/);
});


test('agent activity timeline records lifecycle and messages, filters safely, and caps results', () => {
  const main = {};
  const team = createAgentTeam(main, { name: 'Timeline Team' });
  const worker = registerAgent(main, { type: 'explore', description: 'Inspect routes', teamId: team.team.id, child: { inbox: [] } });
  const peer = registerAgent(main, { type: 'explore', description: 'Inspect tests', teamId: team.team.id, child: { inbox: [] } });
  sendTeamMessage({ agentTasks: main.agentTasks, agentId: worker.id }, { to: peer.id, message: 'Check the edge cases.' });
  recordAgentEvent(main, 'agent.completed', { agentId: worker.id, teamId: team.team.id, description: worker.description });

  const all = agentEvents(main, { limit: 100 });
  assert.ok(all.total >= 5);
  assert.equal(all.events.at(-1).type, 'agent.completed');
  assert.ok(all.events.some((event) => event.type === 'team.created'));
  assert.ok(all.events.some((event) => event.type === 'agent.message_queued' && /edge cases/.test(event.detail)));
  assert.ok(agentEvents(main, { agent_id: worker.id }).events.every((event) => event.agent_id === worker.id));
  assert.ok(agentEvents(main, { team_id: team.team.id }).events.every((event) => event.team_id === team.team.id));
  assert.equal(agentEvents(main, { limit: 1 }).returned, 1);
  assert.throws(() => agentEvents({ agentId: worker.id, agentTasks: main.agentTasks }, {}), /main coordinator/);

  for (let i = 0; i < 510; i++) recordAgentEvent(main, 'test.noise', { detail: String(i) });
  assert.equal(agentRegistry(main).events.length, 500);
  assert.equal(agentEvents(main, { limit: 100 }).returned, 100);
});


test('dispatch_ready_tasks rejects overlapping dispatch attempts without claiming tasks', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-dispatch-lock-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-dispatch-lock-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'dispatch-lock@example.com');
  git('config', 'user.name', 'OASIS test');
  await writeFile(path.join(root, 'target.txt'), 'target\n');
  git('add', '-A');
  git('commit', '-qm', 'fixture baseline');

  const { config } = await modelServer(t, {
    parent: (payload) => {
      const last = payload.messages[payload.messages.length - 1];
      if (last.role === 'user') {
        return { content: null, tool_calls: [
          call('create-task', 'task_create', { subject: 'Inspect target', description: 'Read target.txt and report its contents.' }),
          call('blocked-dispatch', 'dispatch_ready_tasks', { max_parallel: 1 })
        ] };
      }
      if (last.role === 'tool' && last.name === 'dispatch_ready_tasks') return { content: 'dispatch guarded' };
      return { content: 'Unexpected parent step.' };
    }
  });
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  const session = await createSession({ root, config, settings, env });
  t.after(() => closeSession(session));
  agentRegistry(session).dispatchInFlight = true;

  const result = await runAgentTurn(session, 'Create a task and try dispatching while another wave is already running.', { autoApprove: true, env, approval: async () => true });
  assert.equal(result.text, 'dispatch guarded');
  assert.equal(session.sharedTasks.tasks.length, 1);
  assert.equal(session.sharedTasks.tasks[0].status, 'pending');
  assert.equal(session.agentTasks.agents.size, 0);
  assert.ok(session.messages.some((message) => message.role === 'tool' && message.name === 'dispatch_ready_tasks' && /already in progress/.test(String(message.content))));
  session.agentTasks.dispatchInFlight = false;
});


test('dispatch_ready_tasks launches dependency-ready work in isolated waves and carries task IDs into agent status', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-dispatch-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-dispatch-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'dispatch@example.com');
  git('config', 'user.name', 'OASIS test');
  await writeFile(path.join(root, 'alpha.txt'), 'alpha verified\n');
  await writeFile(path.join(root, 'beta.txt'), 'beta verified\n');
  await writeFile(path.join(root, 'gamma.txt'), 'gamma verified\n');
  git('add', '-A');
  git('commit', '-qm', 'fixture baseline');

  let dispatchCalls = 0;
  const { config, parentRequests, childRequests } = await modelServer(t, {
    parent: (payload) => {
      const last = payload.messages[payload.messages.length - 1];
      if (last.role === 'user' && /Create the shared dependency tasks/.test(last.content)) {
        return { content: null, tool_calls: [
          call('create1', 'task_create', { subject: 'Read alpha', description: 'Read alpha.txt and report its existing contents.' }),
          call('create2', 'task_create', { subject: 'Read beta', description: 'Read beta.txt and report its existing contents.', blocked_by: ['task_1'] }),
          call('create3', 'task_create', { subject: 'Read gamma', description: 'Read gamma.txt and report its existing contents.' })
        ] };
      }
      if (last.role === 'user' && /dispatch the next wave/i.test(last.content)) {
        dispatchCalls++;
        return { content: null, tool_calls: [call('wave' + dispatchCalls, 'dispatch_ready_tasks', { max_parallel: 2 })] };
      }
      const alreadyDispatched = payload.messages.some((message) => message.role === 'tool' && message.name === 'dispatch_ready_tasks');
      if (!alreadyDispatched) {
        dispatchCalls++;
        return { content: null, tool_calls: [call('wave' + dispatchCalls, 'dispatch_ready_tasks', { max_parallel: 2 })] };
      }
      return { content: 'dispatch wave finished' };
    },
    child: (payload) => {
      const all = text(payload.messages);
      const match = all.match(/You have been assigned shared task (task_[1-9][0-9]*)/i);
      const taskId = match && match[1];
      const file = ({ task_1: 'alpha.txt', task_2: 'beta.txt', task_3: 'gamma.txt' })[taskId];
      const last = payload.messages[payload.messages.length - 1];
      if (!taskId || !file) return { content: 'Worker prompt did not include a valid shared task assignment.' };
      if (last.role === 'user' && /You have been assigned shared task/i.test(last.content)) {
        return { content: null, tool_calls: [call('claim-' + taskId, 'task_claim', { task_id: taskId, lease_seconds: 60 })] };
      }
      if (last.role === 'tool' && last.name === 'task_claim') {
        return { content: null, tool_calls: [call('read-' + taskId, 'read_file', { path: file })] };
      }
      if (last.role === 'tool' && last.name === 'read_file') {
        assert.ok(last.content.includes(file.replace('.txt', '') + ' verified'), 'worker read expected file content');
        return { content: null, tool_calls: [call('complete-' + taskId, 'task_update', { task_id: taskId, status: 'completed' })] };
      }
      if (last.role === 'tool' && last.name === 'task_update') return { content: 'Verified ' + file + ' and completed ' + taskId + '.' };
      return { content: 'Unexpected child step for ' + taskId + '.' };
    }
  });
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  const session = await createSession({ root, config, settings, env });
  t.after(() => closeSession(session));

  const first = await runAgentTurn(session, 'Create the shared dependency tasks and start wave one.', { autoApprove: true, env, approval: async () => true });
  assert.equal(first.text, 'dispatch wave finished');
  assert.equal(session.agentTasks.dispatchInFlight, false, 'dispatch guard is released after a successful wave');
  await until(() => {
    const tasks = session.sharedTasks.tasks;
    return ['task_1', 'task_3'].every((id) => tasks.find((task) => task.id === id)?.status === 'completed');
  });

  // Assert the dispatcher's effect through task/agent registries rather than a
  // provider-specific string serialization of the tool result.
  assert.equal(session.sharedTasks.tasks.find((task) => task.id === 'task_2').status, 'pending');

  const workers = [...session.agentTasks.agents.values()];
  assert.deepEqual(workers.map((worker) => worker.sharedTaskId).sort(), ['task_1', 'task_3']);
  assert.ok(workers.every((worker) => worker.worktreeInfo && worker.worktreeInfo.path));
  assert.ok(workers.every((worker) => summarizeAgent(worker).task_id === worker.sharedTaskId));
  assert.ok(agentEvents(session, { limit: 100 }).events.some((event) => event.type === 'task.dispatched'));
  const afterFirstWave = runSharedTaskTool(session, 'task_list', { include_completed: false });
  assert.equal(afterFirstWave.tasks.find((task) => task.id === 'task_2').ready, true, 'completing task_1 unlocks task_2 without retroactively adding it to wave one');

  const second = await runAgentTurn(session, 'dispatch the next wave', { autoApprove: true, env, approval: async () => true });
  assert.equal(second.text, 'dispatch wave finished');
  assert.equal(session.agentTasks.dispatchInFlight, false, 'dispatch guard is released before the next wave');
  await until(() => session.sharedTasks.tasks.find((task) => task.id === 'task_2')?.status === 'completed');
  assert.equal(session.agentTasks.agents.size, 3);
  assert.equal(session.agentTasks.agents.get('agent_3').sharedTaskId, 'task_2');
  assert.ok(childRequests.some((request) => text(request.messages).includes('You have been assigned shared task task_2')));
});


test('opt-in auto-dispatch advances dependency waves and pauses with the lease released when a worker exits incomplete', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-auto-dispatch-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-auto-dispatch-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'auto-dispatch@example.com');
  git('config', 'user.name', 'OASIS test');
  await writeFile(path.join(root, 'fixture.txt'), 'workflow fixture\n');
  git('add', '-A');
  git('commit', '-qm', 'fixture baseline');

  const { config, childRequests } = await modelServer(t, {
    parent: (payload) => {
      const last = payload.messages[payload.messages.length - 1];
      if (last.role === 'user' && /Create dependency tasks and enable auto-dispatch/.test(last.content)) {
        return { content: null, tool_calls: [
          call('create-first', 'task_create', { subject: 'Verify first task', description: 'Verify the first prerequisite.' }),
          call('create-second', 'task_create', { subject: 'Verify dependent task', description: 'Verify the dependent task.', blocked_by: ['task_1'] })
        ] };
      }
      if (!payload.messages.some((message) => message.role === 'tool' && message.name === 'dispatch_ready_tasks')) {
        return { content: null, tool_calls: [call('auto-wave', 'dispatch_ready_tasks', { max_parallel: 1, auto_dispatch: true })] };
      }
      return { content: 'auto-dispatch started' };
    },
    child: (payload) => {
      const all = text(payload.messages);
      const match = all.match(/You have been assigned shared task (task_[1-9][0-9]*)/i);
      const taskId = match && match[1];
      const last = payload.messages[payload.messages.length - 1];
      if (!taskId) return { content: 'Worker prompt did not include a shared task ID.' };
      if (last.role === 'user' && /You have been assigned shared task/i.test(last.content)) {
        return { content: null, tool_calls: [call('claim-' + taskId, 'task_claim', { task_id: taskId, lease_seconds: 60 })] };
      }
      if (last.role === 'tool' && last.name === 'task_claim') {
        if (taskId === 'task_1') {
          return { content: null, tool_calls: [call('complete-' + taskId, 'task_update', { task_id: taskId, status: 'completed' })] };
        }
        return { content: 'I could not verify the dependent task. Leaving it for coordinator review.' };
      }
      if (last.role === 'tool' && last.name === 'task_update') return { content: 'Verified prerequisite ' + taskId + '.' };
      return { content: 'Unexpected worker step for ' + taskId + '.' };
    }
  });
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  const session = await createSession({ root, config, settings, env });
  t.after(() => closeSession(session));

  const first = await runAgentTurn(session, 'Create dependency tasks and enable auto-dispatch.', { autoApprove: true, env, approval: async () => true });
  assert.equal(first.text, 'auto-dispatch started');
  await until(() => session.agentTasks.agents.size === 2 &&
    session.sharedTasks.tasks.find((task) => task.id === 'task_1')?.status === 'completed' &&
    session.agentTasks.autoDispatch?.enabled === false);

  const firstTask = session.sharedTasks.tasks.find((task) => task.id === 'task_1');
  const secondTask = session.sharedTasks.tasks.find((task) => task.id === 'task_2');
  assert.equal(firstTask.status, 'completed');
  assert.equal(secondTask.status, 'pending');
  assert.equal(secondTask.claimedBy, '');
  assert.equal(secondTask.claimExpiresAt, null);
  assert.deepEqual([...session.agentTasks.agents.values()].map((agent) => agent.sharedTaskId), ['task_1', 'task_2']);
  assert.ok(childRequests.some((request) => text(request.messages).includes('You have been assigned shared task task_2')));
  assert.ok(agentEvents(session, { limit: 100 }).events.some((event) => event.type === 'task.lease_recovered'));
  assert.ok(agentEvents(session, { limit: 100 }).events.some((event) => event.type === 'task.auto_dispatch_paused'));
});

test('auto-dispatch blocks dependent tasks until prerequisite worktree changes are integrated', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-auto-integration-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-auto-integration-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'auto-integration@example.com');
  git('config', 'user.name', 'OASIS test');
  await writeFile(path.join(root, 'fixture.txt'), 'baseline from main\n');
  git('add', '-A');
  git('commit', '-qm', 'fixture baseline');

  const { config, childRequests } = await modelServer(t, {
    parent: (payload) => {
      const last = payload.messages[payload.messages.length - 1];
      if (last.role === 'user' && /Create tasks and enable auto-dispatch with changed upstream code/.test(last.content)) {
        return { content: null, tool_calls: [
          call('create-upstream', 'task_create', { subject: 'Change the fixture', description: 'Write an updated fixture.txt in the worker worktree, then mark this task completed.' }),
          call('create-downstream', 'task_create', { subject: 'Check the updated fixture', description: 'Inspect the updated fixture after task_1 is integrated.', blocked_by: ['task_1'] })
        ] };
      }
      if (!payload.messages.some((message) => message.role === 'tool' && message.name === 'dispatch_ready_tasks')) {
        return { content: null, tool_calls: [call('auto-wave', 'dispatch_ready_tasks', { max_parallel: 1, auto_dispatch: true })] };
      }
      return { content: 'auto-dispatch started' };
    },
    child: (payload) => {
      const match = text(payload.messages).match(/You have been assigned shared task (task_[1-9][0-9]*)/i);
      const taskId = match && match[1];
      const last = payload.messages[payload.messages.length - 1];
      if (taskId !== 'task_1') return { content: 'Unexpected downstream task launch before integration.' };
      if (last.role === 'user' && /You have been assigned shared task/i.test(last.content)) {
        return { content: null, tool_calls: [call('claim-upstream', 'task_claim', { task_id: taskId, lease_seconds: 60 })] };
      }
      if (last.role === 'tool' && last.name === 'task_claim') {
        return { content: null, tool_calls: [call('write-upstream', 'write_file', { path: 'fixture.txt', content: 'changed by upstream\n' })] };
      }
      if (last.role === 'tool' && last.name === 'write_file') {
        return { content: null, tool_calls: [call('complete-upstream', 'task_update', { task_id: taskId, status: 'completed' })] };
      }
      if (last.role === 'tool' && last.name === 'task_update') return { content: 'Updated fixture.txt and completed task_1.' };
      return { content: 'Unexpected worker step for task_1.' };
    }
  });
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  const session = await createSession({ root, config, settings, env });
  t.after(() => closeSession(session));

  const result = await runAgentTurn(session, 'Create tasks and enable auto-dispatch with changed upstream code.', { autoApprove: true, env, approval: async () => true });
  assert.equal(result.text, 'auto-dispatch started');
  await until(() => session.sharedTasks.tasks.find((task) => task.id === 'task_1')?.status === 'completed' && session.agentTasks.autoDispatch?.enabled === false);

  const upstream = session.sharedTasks.tasks.find((task) => task.id === 'task_1');
  const downstream = session.sharedTasks.tasks.find((task) => task.id === 'task_2');
  assert.equal(upstream.worktreeChanged, true);
  assert.match(upstream.worktreeBranch, /^oasis\//);
  assert.match(upstream.worktreeCommit, /^[0-9a-f]{40}$/i);
  assert.equal(await isCommitIntegrated(root, upstream.worktreeCommit, { env }), false);
  assert.equal(downstream.status, 'pending');
  assert.equal(session.agentTasks.agents.size, 1, 'downstream worker must not start on stale main-checkout code');
  assert.ok(childRequests.some((request) => text(request.messages).includes('You have been assigned shared task task_1')));
  assert.ok(!childRequests.some((request) => text(request.messages).includes('You have been assigned shared task task_2')));
  assert.ok(agentEvents(session, { limit: 100 }).events.some((event) => event.type === 'task.auto_dispatch_paused' && /unintegrated prerequisite changes/.test(event.detail || '')));
});

test('cancelling a dispatched worker immediately releases its shared task lease', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-dispatch-cancel-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-dispatch-cancel-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'dispatch@example.com');
  git('config', 'user.name', 'OASIS test');
  await writeFile(path.join(root, 'target.txt'), 'target\n');
  git('add', '-A'); git('commit', '-qm', 'fixture baseline');

  const hold = gate();
  let reachedWorkerAfterClaim = false;
  const { config } = await modelServer(t, {
    parent: (payload) => {
      const last = payload.messages[payload.messages.length - 1];
      if (last.role === 'user' && /Create and dispatch one task/.test(last.content)) {
        return { content: null, tool_calls: [call('create', 'task_create', { subject: 'Inspect target', description: 'Read target.txt and report what it contains.' })] };
      }
      if (!payload.messages.some((message) => message.role === 'tool' && message.name === 'dispatch_ready_tasks')) {
        return { content: null, tool_calls: [call('dispatch', 'dispatch_ready_tasks', { max_parallel: 1 })] };
      }
      return { content: 'dispatcher returned' };
    },
    child: async (payload) => {
      const last = payload.messages[payload.messages.length - 1];
      const match = text(payload.messages).match(/You have been assigned shared task (task_[1-9][0-9]*)/i);
      const taskId = match && match[1];
      if (!taskId) return { content: 'Missing task assignment.' };
      if (last.role === 'user') return { content: null, tool_calls: [call('claim', 'task_claim', { task_id: taskId, lease_seconds: 60 })] };
      if (last.role === 'tool' && last.name === 'task_claim') {
        reachedWorkerAfterClaim = true;
        await hold.promise;
        return { content: 'This report should not finish before cancellation.' };
      }
      return { content: 'Unexpected worker step.' };
    }
  });
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  const session = await createSession({ root, config, settings, env });
  t.after(() => closeSession(session));

  const result = await runAgentTurn(session, 'Create and dispatch one task', { autoApprove: true, env, approval: async () => true });
  assert.equal(result.text, 'dispatcher returned');
  await until(() => reachedWorkerAfterClaim && session.sharedTasks.tasks[0]?.status === 'in_progress');
  const worker = [...session.agentTasks.agents.values()][0];
  assert.equal(worker.sharedTaskId, 'task_1');
  stopAgent(session, { id: worker.id });
  await until(() => worker.status === 'cancelled');
  hold.open();

  const task = session.sharedTasks.tasks[0];
  assert.equal(task.status, 'pending');
  assert.equal(task.claimedBy, '');
  assert.equal(task.claimExpiresAt, null);
});
