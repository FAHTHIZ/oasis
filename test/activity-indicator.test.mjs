import test from 'node:test';
import assert from 'node:assert/strict';
import { motionLevel, lowPower, describeWait, formatElapsed, formatTokens, shimmer, createActivityIndicator, waitLabel } from '../src/activity-indicator.mjs';
import { isLoopbackProvider } from '../src/agent.mjs';

const GIB = 1024 ** 3;
const bigMachine = { availableParallelism: () => 8, cpus: () => [], totalmem: () => 16 * GIB, loadavg: () => [0.5, 0.5, 0.5] };
const smallMachine = { availableParallelism: () => 2, cpus: () => [], totalmem: () => 16 * GIB, loadavg: () => [0, 0, 0] };
const tty = { isTTY: true, columns: 100 };

test('motion is off for non-TTY output, reduced-motion requests, dumb terminals and CI', () => {
  assert.equal(motionLevel({ env: {}, stream: { isTTY: false } }), 'off');
  assert.equal(motionLevel({ env: { OASIS_REDUCED_MOTION: '1' }, stream: tty }), 'off');
  assert.equal(motionLevel({ env: { NO_MOTION: 'true' }, stream: tty }), 'off');
  assert.equal(motionLevel({ env: { OASIS_AX_SCREEN_READER: '1' }, stream: tty }), 'off');
  assert.equal(motionLevel({ env: { TERM: 'dumb' }, stream: tty }), 'off');
  assert.equal(motionLevel({ env: { CI: 'true' }, stream: tty, system: bigMachine }), 'off');
  assert.equal(motionLevel({ env: { OASIS_MOTION: 'off' }, stream: tty, system: bigMachine }), 'off');
});

test('low-power machines and remote sessions get the lite animation', () => {
  assert.equal(motionLevel({ env: {}, stream: tty, system: bigMachine }), 'full');
  assert.equal(motionLevel({ env: {}, stream: tty, system: smallMachine }), 'lite');
  assert.equal(motionLevel({ env: { SSH_CONNECTION: '1 2 3 4' }, stream: tty, system: bigMachine }), 'lite');
  assert.equal(motionLevel({ env: { TERM: 'linux' }, stream: tty, system: bigMachine }), 'lite');
  assert.equal(lowPower({ env: {}, system: { ...bigMachine, totalmem: () => 2 * GIB } }), true);
  assert.equal(motionLevel({ env: { OASIS_MOTION: 'full' }, stream: tty, system: smallMachine }), 'full');
  assert.equal(motionLevel({ env: { OASIS_MOTION: 'lite' }, stream: tty, system: bigMachine }), 'lite');
});

test('wait description shows label, elapsed time, context size and how to stop', () => {
  assert.equal(formatElapsed(4200), '4s');
  assert.equal(formatElapsed(125000), '2m 05s');
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(15430), '15.4k');
  assert.equal(describeWait({ inputTokens: 15430, step: 1 }, 3000), 'Thinking… · 3s · 15.4k tokens sent · esc to stop');
  assert.match(describeWait({ inputTokens: 900, step: 3 }, 1000), /^Working… · 1s · 900 tokens sent · step 3 · esc to stop$/);
  assert.equal(waitLabel({ local: true, inputTokens: 8000 }, 20000), 'Local model is reading the prompt');
  assert.equal(waitLabel({ local: false, inputTokens: 8000 }, 50000), 'Still waiting for the model');
});

test('shimmer keeps the text intact and moves the highlight', () => {
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(strip(shimmer('Thinking…', 0)), 'Thinking…');
  assert.notEqual(shimmer('Thinking…', 2), shimmer('Thinking…', 6));
});

test('indicator draws on one line, then clears it when stopped', () => {
  const writes = [];
  let tick = null;
  let cleared = false;
  let clock = 1000;
  const stream = { isTTY: true, columns: 80, write: (chunk) => writes.push(chunk) };
  const indicator = createActivityIndicator({ stream, env: { OASIS_MOTION: 'full' }, color: false, now: () => clock, timers: { setInterval: (fn) => { tick = fn; return { unref() {} }; }, clearInterval: () => { cleared = true; } } });
  assert.equal(indicator.level, 'full');
  assert.equal(indicator.start({ inputTokens: 2000, step: 1 }), true);
  clock += 5000;
  tick();
  assert.ok(writes.every((w) => w.startsWith('\r\x1b[2K')));
  assert.ok(!writes.some((w) => w.includes('\n')), 'never scrolls the terminal');
  assert.match(writes.at(-1), /Thinking… · 5s · 2k tokens sent · esc to stop/);
  indicator.stop();
  assert.equal(cleared, true);
  assert.equal(writes.at(-1), '\r\x1b[2K\x1b[?25h', 'clears the line and shows the cursor again');
  const count = writes.length;
  indicator.stop();
  assert.equal(writes.length, count, 'stopping twice writes nothing');
});

test('indicator is silent when motion is off', () => {
  const writes = [];
  const indicator = createActivityIndicator({ stream: { isTTY: false, write: (c) => writes.push(c) }, env: {} });
  assert.equal(indicator.start({}), false);
  indicator.stop();
  assert.deepEqual(writes, []);
});

test('long lines are clipped to the terminal width', () => {
  const writes = [];
  const stream = { isTTY: true, columns: 30, write: (chunk) => writes.push(chunk) };
  const indicator = createActivityIndicator({ stream, env: { OASIS_MOTION: 'lite' }, color: false, timers: { setInterval: () => ({}), clearInterval: () => {} } });
  indicator.start({ inputTokens: 123456, step: 9 });
  const visible = writes[0].replace('\r\x1b[2K', '').replace('\x1b[?25l', '');
  assert.ok([...visible].length <= 33, visible);
  indicator.stop();
});

test('local providers are recognised for the longer first-token wait', () => {
  assert.equal(isLoopbackProvider({ baseURL: 'http://127.0.0.1:8080/v1' }), true);
  assert.equal(isLoopbackProvider({ baseURL: 'http://localhost:11434/v1' }), true);
  assert.equal(isLoopbackProvider({ baseURL: 'http://[::1]:1234/v1' }), true);
  assert.equal(isLoopbackProvider({ baseURL: 'https://api.anthropic.com' }), false);
  assert.equal(isLoopbackProvider({}), false);
});

test('request timeouts: local default, cloud defaults and explicit values', async () => {
  const { requestTimeoutMs } = await import('../src/agent.mjs');
  assert.equal(requestTimeoutMs({ streaming: true }), 120000);
  assert.equal(requestTimeoutMs({}), 600000);
  assert.equal(requestTimeoutMs({ local: true, streaming: true }), 900000);
  assert.equal(requestTimeoutMs({ configuredSeconds: 2400, local: true }), 2400000, 'explicit setting is not capped at 15 minutes');
  assert.equal(requestTimeoutMs({ configuredSeconds: 99999 }), 7200000);
  assert.equal(requestTimeoutMs({ timeoutMs: 5000, configuredSeconds: 2400 }), 5000);
  assert.equal(requestTimeoutMs({ timeoutMs: 5000000 }), 900000);
});

test('a rate-limit wait counts down in the spinner, then falls back to the usual label', async () => {
  const { describeWait, waitLabel } = await import('../src/activity-indicator.mjs');
  assert.equal(describeWait({ rateLimitMs: 13000 }, 0), 'Rate limited… · retrying in 13s · esc to stop');
  assert.equal(describeWait({ rateLimitMs: 13000 }, 4200), 'Rate limited… · retrying in 9s · esc to stop');
  assert.equal(waitLabel({ rateLimitMs: 13000 }, 14000), 'Thinking');
  assert.match(describeWait({ rateLimitMs: 13000 }, 14000), /^Thinking… · 14s/);
});
