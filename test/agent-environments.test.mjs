import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { runSubagent } from '../src/agent-subagents.mjs';
import { taskToolDefinition, loadAgentDefinitions, BUILTIN_AGENTS } from '../src/subagents.mjs';
import { agentEnvironmentStatus, closeAgentEnvironment, releaseAgentEnvironment } from '../src/agent-tasks.mjs';
import { agentDisplayEnv } from '../src/computer-use.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
const baseEnv = { ...process.env, OASIS_NEURON_LEDGER: '0' };

test('the task tool offers environment: desktop and agent files can ask for it', async (t) => {
  const definition = taskToolDefinition(BUILTIN_AGENTS);
  assert.deepEqual(definition.function.parameters.properties.environment.enum, ['shared', 'desktop']);
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.oasis', 'agents'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'agents', 'web-tester.md'), '---\nname: web-tester\ndescription: Tests the site in a browser\nenvironment: desktop\n---\nTest the site.\n');
  const agents = await loadAgentDefinitions(root, { env: { ...baseEnv, HOME: root } });
  assert.equal(agents['web-tester'].environment, 'desktop');
  assert.equal(agents['general-purpose'].environment || null, null);
});

test('a desktop environment is refused where it cannot be private', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = await createSession({ root, settings, env: { ...baseEnv, HOME: root }, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'fixture', apiKey: '', maxSteps: 2 } });
  t.after(() => closeSession(session));
  await assert.rejects(runSubagent(session, { description: 'gui', prompt: 'Open the app.', environment: 'desktop' }, {}, { env: baseEnv, platform: 'darwin' }), /needs Linux with Xvfb/);
  await assert.rejects(runSubagent(session, { description: 'gui', prompt: 'Open the app.', environment: 'moon' }, {}, { env: baseEnv }), /environment must be/);
  session.restricted = true;
  await assert.rejects(runSubagent(session, { description: 'gui', prompt: 'Open the app.', environment: 'desktop' }, {}, { env: baseEnv, platform: 'linux' }), /restricted/);
});

test('a finished child closes its browser and computer backend; a desktop child waits for its idle timeout', () => {
  const closed = [];
  const backend = { close: () => closed.push('backend') };
  const virtual = { display: ':91', stop: () => closed.push('screen') };
  const shared = { agentEnvironment: 'shared', computerState: { backend, virtual: null, launched: [] } };
  releaseAgentEnvironment(shared, {});
  assert.deepEqual(closed, ['backend']);
  assert.equal(shared.computerState, null);

  closed.length = 0;
  const desktop = { agentEnvironment: 'desktop', computerState: { backend, virtual, launched: [] } };
  releaseAgentEnvironment(desktop, { OASIS_AGENT_ENVIRONMENT_IDLE_MS: '60000' });
  assert.deepEqual(closed, [], 'kept for a follow-up message');
  assert.deepEqual(agentEnvironmentStatus(desktop), { kind: 'desktop', screen: ':91', idle: true });
  assert.equal(closeAgentEnvironment(desktop), 1);
  assert.deepEqual(closed, ['backend', 'screen']);
  assert.equal(desktop.environmentIdleTimer, null);
  assert.deepEqual(agentEnvironmentStatus(desktop), { kind: 'desktop', screen: 'starts on first use' });

  closed.length = 0;
  const now = { agentEnvironment: 'desktop', computerState: { backend, virtual, launched: [] } };
  releaseAgentEnvironment(now, { OASIS_AGENT_ENVIRONMENT_IDLE_MS: '0' });
  assert.deepEqual(closed, ['backend', 'screen']);
  assert.equal(agentEnvironmentStatus({ agentEnvironment: 'shared' }), null);
});

test('the browser of an agent with a virtual screen opens visibly on that screen', async () => {
  const session = { computerDisplay: 'virtual' };
  const env = await agentDisplayEnv(session, { PATH: '/usr/bin' }, { startVirtualDisplay: async () => ({ display: ':93', stop() {} }) });
  assert.equal(env.DISPLAY, ':93');
  assert.equal(env.OASIS_CHROME_HEADLESS, '0');
  assert.equal(await agentDisplayEnv({}, { PATH: '/usr/bin' }), null, 'the shared display needs no change');
});

const which = (cmd) => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };
const haveVirtual = process.platform === 'linux' && ['Xvfb', 'xdotool'].every(which) && (which('scrot') || which('import'));

test('two desktop subagents run in parallel, each on its own screen, and their screens close after', { skip: haveVirtual ? false : 'needs Xvfb, xdotool and scrot or ImageMagick' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...baseEnv, HOME: root, OASIS_COMPUTER_DRIVER: 'native', OASIS_COMPUTER_VNC: '0', OASIS_AGENT_ENVIRONMENT_IDLE_MS: '0' };
  delete env.DISPLAY;
  const displays = [];
  const { config } = await scriptedModel(t, [(payload) => {
    const system = String(payload.messages[0].content || '');
    const last = payload.messages[payload.messages.length - 1];
    if (system.includes('PRIVATE DESKTOP')) {
      if (last.role !== 'tool') return toolCall('shot' + Math.random().toString(36).slice(2, 8), 'computer', { action: 'screenshot' });
      const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
      const display = (text.match(/"virtual_display":"(:\d+)"/) || [])[1] || 'none';
      displays.push(display);
      return { content: 'Screen ' + display + ' is up.' };
    }
    if (last.role === 'user') return { content: null, tool_calls: ['a', 'b'].map((id) => ({ id: 'task_' + id, type: 'function', function: { name: 'task', arguments: JSON.stringify({ description: 'look ' + id, prompt: 'Take a screenshot and report your screen.', environment: 'desktop' }) } })) };
    return { content: 'done' };
  }]);
  const session = await createSession({ root, settings, env, config: { ...config, maxSteps: 6 } });
  t.after(() => closeSession(session));
  assert.ok(!session.toolDefinitions.some((tool) => tool.function.name === 'computer'), 'the parent itself has no computer tool');
  await runAgentTurn(session, 'check the screens', { env, approval: async () => true });
  assert.equal(displays.length, 2, JSON.stringify(session.messages.filter((m) => m.role === 'tool').map((m) => String(m.content).slice(0, 300))));
  assert.ok(displays.every((display) => /^:\d+$/.test(display)), displays.join(','));
  assert.notEqual(displays[0], displays[1], 'each agent has its own screen');
  for (const display of displays) {
    const socket = '/tmp/.X11-unix/X' + display.slice(1);
    for (let i = 0; i < 30 && existsSync(socket); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(socket), false, display + ' closed after its agent finished');
  }
});

test('closing a browser tab settles its waits at once, so nothing holds the process open', async () => {
  const { CdpPage } = await import('../src/cdp.mjs');
  const sent = [];
  const ws = { send: (text) => sent.push(text), close() {}, onmessage: null, onclose: null };
  const page = new CdpPage(ws, { id: 't' });
  const started = Date.now();
  const event = page.once('Page.loadEventFired', 60_000);
  const command = page.send('Page.navigate', { url: 'about:blank' }, 60_000);
  page.close();
  assert.equal(await event, null);
  await assert.rejects(command, /tab closed/);
  assert.ok(Date.now() - started < 1000);
  assert.equal(await page.once('Page.loadEventFired', 60_000), null, 'a closed tab waits for nothing');
  assert.equal(sent.length, 1);
});

test('--restricted holds for nested agents: a grandchild cannot get a desktop environment', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...baseEnv, HOME: root };
  const seen = [];
  const { config } = await scriptedModel(t, [(payload) => {
    const system = String(payload.messages[0].content || '');
    const last = payload.messages[payload.messages.length - 1];
    seen.push((payload.tools || []).map((tool) => tool.function.name));
    if (system.includes('PRIVATE DESKTOP')) return { content: 'grandchild ran' };
    if (system.includes('SUBAGENT MODE')) {
      if (last.role !== 'tool') return toolCall('inner', 'task', { description: 'inner', prompt: 'Look at the screen.', environment: 'desktop' });
      return { content: 'child: ' + String(last.content).slice(0, 300) };
    }
    if (last.role === 'user') return toolCall('outer', 'task', { description: 'outer', prompt: 'Start a helper.' });
    return { content: 'done' };
  }]);
  const session = await createSession({ root, settings, env, restricted: true, config: { ...config, maxSteps: 4 } });
  t.after(() => closeSession(session));
  assert.equal(session.restricted, true);
  await runAgentTurn(session, 'go', { env, approval: async () => true, platform: 'linux' });
  assert.ok(seen.every((names) => !names.includes('computer') && !names.includes('browser')), JSON.stringify(seen));
  const report = session.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n');
  assert.match(report, /not available in --restricted mode/);
});
