import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { PtySessionManager } from '../src/pty-sessions.mjs';

function makeFakePty() {
  const processes = [];
  return {
    processes,
    module: {
      spawn(command, args, options) {
        const data = new Set();
        const exits = new Set();
        const child = {
          command, args, options, writes: [], resizes: [], killSignals: [], killed: false,
          onData(callback) { data.add(callback); return { dispose: () => data.delete(callback) }; },
          onExit(callback) { exits.add(callback); return { dispose: () => exits.delete(callback) }; },
          write(value) { this.writes.push(value); },
          resize(cols, rows) { this.resizes.push([cols, rows]); },
          kill(signal) {
            this.killSignals.push(signal || 'default');
            if (signal === 'SIGKILL' || !signal) {
              this.killed = true;
              for (const callback of [...exits]) callback({ exitCode: 137, signal: 9 });
            }
          },
          emitData(value) { for (const callback of [...data]) callback(value); },
          emitExit(event = { exitCode: 0, signal: 0 }) { for (const callback of [...exits]) callback(event); }
        };
        processes.push(child);
        return child;
      }
    }
  };
}

test('starts an argv-based PTY session and reads output by cursor', async () => {
  const fake = makeFakePty();
  const manager = new PtySessionManager({ loadPty: async () => fake.module, idFactory: () => 'term_test' });
  const started = await manager.start('/usr/bin/node', ['-e', 'process.stdin.resume()'], { cwd: '/workspace', env: { PATH: '/bin' }, cols: 90, rows: 24 });
  assert.equal(started.id, 'term_test');
  assert.equal(started.state, 'running');
  assert.equal(fake.processes[0].options.cols, 90);
  fake.processes[0].emitData('hello');
  const first = await manager.read(started.id, { offset: 0 });
  assert.equal(first.output, 'hello');
  assert.equal(first.nextOffset, 5);
  fake.processes[0].emitData(' world');
  const next = await manager.read(started.id, { offset: first.nextOffset });
  assert.equal(next.output, ' world');
  assert.equal(next.nextOffset, 11);
  fake.processes[0].emitExit({ exitCode: 0, signal: 0 });
  assert.equal(manager.list().sessions[0].state, 'exited');
  assert.equal(manager.list().sessions[0].exitCode, 0);
});

test('reserves terminal capacity while the native PTY module is still loading', async () => {
  const fake = makeFakePty();
  let resolveModule;
  const manager = new PtySessionManager({
    loadPty: () => new Promise((resolve) => { resolveModule = resolve; }),
    maxSessions: 1,
    idFactory: () => 'term_reserved'
  });

  const firstStart = manager.start('node', [], { cwd: '/workspace', env: {} });
  await Promise.resolve();
  assert.equal(typeof resolveModule, 'function', 'the first launch should be waiting for the native module');
  await assert.rejects(
    manager.start('node', [], { cwd: '/workspace', env: {} }),
    /active or starting terminal sessions/
  );

  resolveModule(fake.module);
  const started = await firstStart;
  assert.equal(started.state, 'running');
  assert.equal(fake.processes.length, 1);
  assert.equal(manager.startingSessions, 0);
  fake.processes[0].emitExit({ exitCode: 0, signal: 0 });
});

test('bounds captured output and reports lost cursor content', async () => {
  const fake = makeFakePty();
  const manager = new PtySessionManager({ loadPty: async () => fake.module, bufferLimit: 1024, idFactory: () => 'term_buffer' });
  const started = await manager.start('node', [], { cwd: '/workspace', env: {} });
  fake.processes[0].emitData('a'.repeat(1200));
  const result = await manager.read(started.id, { offset: 0, maxChars: 64 });
  assert.equal(result.output.length, 64);
  assert.equal(result.truncated, true);
  assert.equal(result.offset, 176);
  assert.equal(result.moreOutput, true);
});

test('writes input, resizes, sends Ctrl+C, and stops sessions', async () => {
  const fake = makeFakePty();
  const manager = new PtySessionManager({ loadPty: async () => fake.module, idFactory: () => 'term_controls', killGraceMs: 20 });
  const started = await manager.start('node', [], { cwd: '/workspace', env: {} });
  assert.equal(manager.write(started.id, 'yes' + String.fromCharCode(13)).writtenChars, 4);
  assert.deepEqual(fake.processes[0].writes, ['yes' + String.fromCharCode(13)]);
  assert.equal(manager.resize(started.id, 120, 40).cols, 120);
  assert.deepEqual(fake.processes[0].resizes, [[120, 40]]);
  assert.equal(manager.interrupt(started.id).interrupted, true);
  assert.equal(fake.processes[0].writes[1], String.fromCharCode(3));
  assert.equal(manager.stop(started.id).stopped, true);
  assert.deepEqual(fake.processes[0].killSignals, ['SIGTERM']);
  assert.equal(manager.list().sessions[0].state, 'stopping');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(fake.processes[0].killSignals, ['SIGTERM', 'SIGKILL']);
  assert.equal(fake.processes[0].killed, true);
  assert.equal(manager.list().sessions[0].state, 'exited');
});

test('rejects invalid inputs and enforces the active-session limit', async () => {
  const fake = makeFakePty();
  let id = 0;
  const manager = new PtySessionManager({ loadPty: async () => fake.module, maxSessions: 1, idFactory: () => 'term_' + (++id) });
  await assert.rejects(manager.start('', [], { cwd: '/workspace', env: {} }), /valid executable/);
  await assert.rejects(manager.start('node', ['bad' + String.fromCharCode(0) + 'arg'], { cwd: '/workspace', env: {} }), /short strings/);
  await manager.start('node', [], { cwd: '/workspace', env: {} });
  await assert.rejects(manager.start('node', [], { cwd: '/workspace', env: {} }), /active terminal sessions/);
});

test('waits briefly for output instead of returning before a process produces it', async () => {
  const fake = makeFakePty();
  const manager = new PtySessionManager({ loadPty: async () => fake.module, idFactory: () => 'term_wait' });
  const started = await manager.start('node', [], { cwd: '/workspace', env: {} });
  const read = manager.read(started.id, { offset: 0, waitMs: 1000 });
  setTimeout(() => fake.processes[0].emitData('ready'), 5);
  assert.equal((await read).output, 'ready');
  manager.closeAll();
});

test('explains a missing native dependency without breaking normal module imports', async () => {
  const manager = new PtySessionManager({ loadPty: async () => { const error = new Error("Cannot find package 'node-pty'"); error.code = 'ERR_MODULE_NOT_FOUND'; throw error; } });
  await assert.rejects(manager.start('node', [], { cwd: '/workspace', env: {} }), /optional native node-pty component/);
});

const require = createRequire(import.meta.url);
let nativePtyPresent = false;
try { require.resolve('node-pty'); nativePtyPresent = true; } catch {}

test('native PTY launches a real process and captures its output', { skip: !nativePtyPresent }, async () => {
  const manager = new PtySessionManager();
  try {
    const started = await manager.start(process.execPath, ['-e', 'process.stdout.write("OASIS_PTY_OK")'], { cwd: process.cwd(), env: process.env });
    const exit = await manager.waitForExit(started.id, 20000);
    assert.equal(exit.timedOut, undefined);
    const output = await manager.read(started.id, { offset: 0, maxChars: 1000 });
    assert.equal(exit.state, 'exited');
    assert.match(output.output, /OASIS_PTY_OK/);
    assert.equal(exit.exitCode, 0);
  } finally {
    manager.closeAll();
  }
});
