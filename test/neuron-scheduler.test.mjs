import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNeuronScheduler, parseProviderSlots, providerKey, describeWait, NETWORK_RUNNING_CAP } from '../src/neuron-scheduler.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { agentRegistry } from '../src/agent-tasks.mjs';

// A small deterministic generator so a failing seed can be replayed.
function random(seed) {
  let state = seed >>> 0 || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('random spawn trees never exceed the network, parent or provider limits, and always finish', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rand = random(seed);
    const globalCap = 1 + Math.floor(rand() * 8);
    const childrenCap = 1 + Math.floor(rand() * 4);
    const providers = ['a.example', 'b.example', ''];
    const providerSlots = { 'a.example': 1 + Math.floor(rand() * 3) };
    const scheduler = createNeuronScheduler({ globalCap, childrenCap, providerSlots });
    const live = new Map();
    let next = 1;
    let violations = '';
    const check = () => {
      const perParent = new Map();
      const perProvider = new Map();
      const working = [...live.values()].filter((node) => !node.parked);
      if (working.length > globalCap) violations ||= 'working ' + working.length + ' > ' + globalCap;
      for (const node of working) {
        perParent.set(node.parentId, (perParent.get(node.parentId) || 0) + 1);
        perProvider.set(node.provider, (perProvider.get(node.provider) || 0) + 1);
      }
      for (const [parent, n] of perParent) if (n > childrenCap) violations ||= 'parent ' + parent + ' ' + n + ' > ' + childrenCap;
      if ((perProvider.get('a.example') || 0) > providerSlots['a.example']) violations ||= 'provider a.example over its slots';
    };
    // A neuron works for a few ticks, may start background children (that it
    // does not wait for) and foreground children (that it waits for, lending
    // its slot to the first), then finishes.
    const runNeuron = async (parentId, parentTicket, depth) => {
      const id = 'n' + next++;
      const provider = providers[Math.floor(rand() * providers.length)];
      if (parentTicket) { parentTicket.park(); live.get(parentId).parked++; }
      const ticket = await scheduler.acquire({ id, parentId, provider });
      live.set(id, { parentId, provider, parked: 0 });
      check();
      const work = [];
      for (let i = 0; i < 1 + Math.floor(rand() * 3); i++) await tick();
      if (depth < 3) {
        const background = Math.floor(rand() * 3);
        for (let i = 0; i < background; i++) work.push(runNeuron(id, null, depth + 1));
        const foreground = Math.floor(rand() * 3);
        const waits = [];
        for (let i = 0; i < foreground; i++) {
          waits.push(runNeuron(id, ticket, depth + 1).then(async () => {
            await ticket.unpark();
            live.get(id).parked--;
            check();
          }));
        }
        await Promise.all(waits);
      }
      live.delete(id);
      ticket.release();
      check();
      return Promise.all(work);
    };
    const roots = Array.from({ length: 2 + Math.floor(rand() * 10) }, () => runNeuron('main', null, 1));
    const finished = await Promise.race([Promise.all(roots).then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5000))]);
    assert.ok(finished, 'seed ' + seed + ': the network deadlocked');
    assert.equal(violations, '', 'seed ' + seed + ': ' + violations);
    assert.equal(scheduler.snapshot().running, 0, 'seed ' + seed + ': every slot was released');
    assert.equal(scheduler.snapshot().queued, 0);
  }
});

test('a request past the limit waits, explains why, and can be cancelled while it waits', async () => {
  const scheduler = createNeuronScheduler({ globalCap: 1 });
  const first = await scheduler.acquire({ id: 'a' });
  let queuedWith = null;
  const second = scheduler.acquire({ id: 'b' }, { onQueued: (info) => { queuedWith = info; } });
  assert.deepEqual(queuedWith, { limit: 'network', cap: 1, running: 1, position: 1 });
  assert.deepEqual(scheduler.wouldWait({ id: 'c' }), { limit: 'network', cap: 1, running: 1 });
  const controller = new AbortController();
  const third = scheduler.acquire({ id: 'c' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(third, { name: 'AbortError' });
  assert.equal(scheduler.snapshot().queued, 1, 'the cancelled request left the queue');
  first.release();
  const granted = await second;
  assert.match(describeWait(granted.waitedFor, granted.waitedMs), /^Queued for [\d.]+ s before starting: 1 agents were already running across the network \(limit 1\)\.$/);
  granted.release();
  granted.release();
  assert.equal(scheduler.snapshot().running, 0, 'releasing twice is harmless');
});

test('a parent blocked on foreground children gives up its slot until the last returns', async () => {
  const scheduler = createNeuronScheduler({ globalCap: 1 });
  const parent = await scheduler.acquire({ id: 'p' });
  parent.park();
  parent.park();
  const child = await scheduler.acquire({ id: 'c1', parentId: 'p' });
  assert.equal(scheduler.snapshot().running, 1, 'the child runs in the parked slot');
  child.release();
  await parent.unpark();
  assert.equal(scheduler.snapshot().running, 0, 'still parked: one child is outstanding');
  const other = await scheduler.acquire({ id: 'x' });
  const resumed = parent.unpark();
  let back = false;
  resumed.then(() => { back = true; });
  await tick();
  assert.equal(back, false, 'the parent waits for a slot like anyone else');
  other.release();
  await resumed;
  assert.equal(scheduler.snapshot().running, 1);
  parent.release();
  assert.equal(scheduler.snapshot().running, 0);
});

test('limits and provider keys are parsed defensively', () => {
  assert.equal(createNeuronScheduler().globalCap, NETWORK_RUNNING_CAP);
  assert.equal(createNeuronScheduler({ globalCap: '3' }).globalCap, 3);
  assert.equal(createNeuronScheduler({ globalCap: '0' }).globalCap, NETWORK_RUNNING_CAP);
  assert.deepEqual(parseProviderSlots('API.OpenAI.com=2, bad, x=0,y=1'), { 'api.openai.com': 2, y: 1 });
  assert.deepEqual(parseProviderSlots({ 'a.example': 1 }), { 'a.example': 1 });
  assert.equal(providerKey({ baseURL: 'https://api.example.com/v1' }), 'api.example.com');
  assert.equal(providerKey({ protocol: 'anthropic' }), 'anthropic');
});

// The main agent asks for subagents in one reply; each child's model request
// is held for a moment so overlap is visible.
async function run(t, { tasks = 5, background = false, env: extraEnv = () => ({}) } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-scheduler-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = path.join(root, '.config-oasis');
  await mkdir(configDir, { recursive: true });
  let active = 0;
  let peak = 0;
  let children = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    let message;
    if (/SUBAGENT MODE/.test(String(payload.messages[0].content))) {
      children++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 120));
      active--;
      message = { role: 'assistant', content: 'child report' };
    } else if (payload.messages.some((m) => m.role === 'tool')) {
      message = { role: 'assistant', content: 'done' };
    } else {
      message = { role: 'assistant', content: null, tool_calls: Array.from({ length: tasks }, (_, i) => ({ id: 'c' + i, type: 'function', function: { name: 'task', arguments: JSON.stringify({ description: 'look ' + i, prompt: 'Report ' + i + '.', subagent_type: 'explore', ...(background ? { run_in_background: true } : {}) }) } })) };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const env = { ...process.env, OASIS_SUBAGENT_MAX_PARALLEL: '', OASIS_SUBAGENT_EFFORT: '', CLAUDE_CODE_SUBAGENT_EFFORT: '', OASIS_NETWORK_MAX_RUNNING: '', OASIS_PROVIDER_SLOTS: '', OASIS_CONFIG_DIR: configDir, ...extraEnv(port) };
  const session = await createSession({ root, env, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 } });
  await runAgentTurn(session, 'go', { autoApprove: true, env });
  const results = session.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
  return { session, results, stats: () => ({ peak, children }) };
}

test('OASIS_NETWORK_MAX_RUNNING caps the whole network and queued children say why', async (t) => {
  const { results, stats } = await run(t, { env: () => ({ OASIS_NETWORK_MAX_RUNNING: '2' }) });
  assert.equal(stats().children, 5);
  assert.equal(stats().peak, 2);
  const notes = results.filter((text) => /Queued for [\d.]+ s before starting: 2 agents were already running across the network \(limit 2\)/.test(text));
  assert.ok(notes.length >= 3, 'the three children that waited explain it: ' + results.join('\n'));
});

test('OASIS_PROVIDER_SLOTS limits children on one provider host', async (t) => {
  const { stats } = await run(t, { tasks: 3, env: (port) => ({ OASIS_PROVIDER_SLOTS: '127.0.0.1:' + port + '=1' }) });
  assert.equal(stats().children, 3);
  assert.equal(stats().peak, 1);
});

test('background children past the cap are queued, told so, and still run', async (t) => {
  const { session, results, stats } = await run(t, { tasks: 3, background: true, env: () => ({ OASIS_NETWORK_MAX_RUNNING: '1' }) });
  assert.equal(results.filter((text) => /"status":"queued"/.test(text) && /starts by itself when a slot frees/.test(text)).length, 2, results.join('\n'));
  const registry = agentRegistry(session);
  const deadline = Date.now() + 10000;
  while ([...registry.agents.values()].some((record) => record.status === 'running') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual([...registry.agents.values()].map((record) => record.status), ['completed', 'completed', 'completed']);
  assert.equal(stats().children, 3);
  assert.equal(stats().peak, 1);
  assert.ok(registry.events.some((event) => event.type === 'agent.queued'), 'the timeline shows the wait');
});
