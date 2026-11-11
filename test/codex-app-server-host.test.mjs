import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createAppServerHost, isInside } from '../src/codex-app-server-host.mjs';
import { createCodexAppServer } from '../src/codex-app-server.mjs';

async function tmp(t, prefix = 'oasis-host-') {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function hostFor(root, extra = {}) {
  const notes = [];
  const host = createAppServerHost({ cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME || '' }, notify: (method, params) => notes.push({ method, params }), ...extra });
  return { host, notes };
}

const b64 = (text) => Buffer.from(text).toString('base64');
const unb64 = (text) => Buffer.from(text, 'base64').toString('utf8');

test('isInside handles equal, nested and sibling-prefix paths', () => {
  assert.equal(isInside('/a/b', '/a/b'), true);
  assert.equal(isInside('/a/b', '/a/b/c'), true);
  assert.equal(isInside('/a/b', '/a/bc'), false);
  assert.equal(isInside('/a/b', '/a'), false);
});

test('fs round trip: write, read, metadata, directory listing, copy, remove', async (t) => {
  const root = await tmp(t);
  const { host } = hostFor(root);
  await host.handle('fs/createDirectory', { path: path.join(root, 'src', 'deep') });
  await host.handle('fs/writeFile', { path: path.join(root, 'src', 'a.txt'), dataBase64: b64('hello') });
  assert.equal(unb64((await host.handle('fs/readFile', { path: path.join(root, 'src', 'a.txt') })).dataBase64), 'hello');
  const meta = await host.handle('fs/getMetadata', { path: path.join(root, 'src', 'a.txt') });
  assert.equal(meta.isFile, true);
  assert.equal(meta.isDirectory, false);
  assert.equal(meta.isSymlink, false);
  assert.ok(meta.modifiedAtMs > 0);
  const listing = await host.handle('fs/readDirectory', { path: path.join(root, 'src') });
  assert.deepEqual(listing.entries, [{ fileName: 'a.txt', isDirectory: false, isFile: true }, { fileName: 'deep', isDirectory: true, isFile: false }]);
  await assert.rejects(host.handle('fs/copy', { sourcePath: path.join(root, 'src'), destinationPath: path.join(root, 'copy') }), /recursive: true/);
  await host.handle('fs/copy', { sourcePath: path.join(root, 'src'), destinationPath: path.join(root, 'copy'), recursive: true });
  assert.equal(await readFile(path.join(root, 'copy', 'a.txt'), 'utf8'), 'hello');
  await assert.rejects(host.handle('fs/copy', { sourcePath: path.join(root, 'src'), destinationPath: path.join(root, 'src', 'deep', 'x'), recursive: true }), /into itself/);
  await host.handle('fs/remove', { path: path.join(root, 'copy') });
  await assert.rejects(readFile(path.join(root, 'copy', 'a.txt')), /ENOENT/);
  await assert.rejects(host.handle('fs/remove', { path: root }), /root folder/);
});

test('fs paths must be absolute and inside an allowed root; symlinks cannot escape', async (t) => {
  const root = await tmp(t);
  const outside = await tmp(t, 'oasis-host-out-');
  await writeFile(path.join(outside, 'secret.txt'), 'nope');
  await symlink(outside, path.join(root, 'link'));
  const { host } = hostFor(root);
  await assert.rejects(host.handle('fs/readFile', { path: 'relative.txt' }), (error) => error.rpc.code === -32602 && /absolute/.test(error.message));
  await assert.rejects(host.handle('fs/readFile', { path: path.join(outside, 'secret.txt') }), (error) => error.rpc.code === -32001);
  await assert.rejects(host.handle('fs/readFile', { path: path.join(root, 'link', 'secret.txt') }), (error) => error.rpc.code === -32001);
  await assert.rejects(host.handle('fs/writeFile', { path: path.join(root, 'link', 'new.txt'), dataBase64: b64('x') }), (error) => error.rpc.code === -32001);
  await assert.rejects(host.handle('fs/readFile', { path: path.join(root, '..', path.basename(outside), 'secret.txt') }), (error) => error.rpc.code === -32001);
  host.addRoot(outside);
  assert.equal(unb64((await host.handle('fs/readFile', { path: path.join(outside, 'secret.txt') })).dataBase64), 'nope');
});

test('OASIS_APP_SERVER_FS_ROOTS adds roots', async (t) => {
  const root = await tmp(t);
  const extra = await tmp(t, 'oasis-host-extra-');
  await writeFile(path.join(extra, 'f'), 'ok');
  const host = createAppServerHost({ cwd: root, env: { OASIS_APP_SERVER_FS_ROOTS: extra } });
  assert.equal(unb64((await host.handle('fs/readFile', { path: path.join(extra, 'f') })).dataBase64), 'ok');
});

test('read-only hosts refuse writes and commands but still read', async (t) => {
  const root = await tmp(t);
  await writeFile(path.join(root, 'f'), 'r');
  const { host } = hostFor(root, { readOnly: true });
  assert.equal(unb64((await host.handle('fs/readFile', { path: path.join(root, 'f') })).dataBase64), 'r');
  await assert.rejects(host.handle('fs/writeFile', { path: path.join(root, 'g'), dataBase64: '' }), /read-only/);
  await assert.rejects(host.handle('command/exec', { command: ['true'] }), /read-only/);
});

test('fs/watch reports changed paths and fs/unwatch stops it', async (t) => {
  const root = await tmp(t);
  const { host, notes } = hostFor(root);
  t.after(() => host.close());
  const result = await host.handle('fs/watch', { watchId: 'w1', path: root });
  assert.equal(result.path, root);
  await assert.rejects(host.handle('fs/watch', { watchId: 'w1', path: root }), /already in use/);
  await writeFile(path.join(root, 'new.txt'), 'x');
  const deadline = Date.now() + 5000;
  while (!notes.some((note) => note.method === 'fs/changed') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  const change = notes.find((note) => note.method === 'fs/changed');
  assert.ok(change, 'expected an fs/changed notification');
  assert.equal(change.params.watchId, 'w1');
  assert.ok(change.params.changedPaths.includes(path.join(root, 'new.txt')));
  await host.handle('fs/unwatch', { watchId: 'w1' });
  notes.length = 0;
  await writeFile(path.join(root, 'later.txt'), 'x');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(notes.filter((note) => note.method === 'fs/changed').length, 0);
});

test('command/exec buffers output, sets cwd and env, and reports the exit code', async (t) => {
  const root = await tmp(t);
  await mkdir(path.join(root, 'sub'));
  const { host } = hostFor(root);
  const result = await host.handle('command/exec', { command: [process.execPath, '-e', 'console.log(process.cwd()); console.error(process.env.HELLO); process.exit(3)'], cwd: 'sub', env: { HELLO: 'world' } });
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout.trim(), path.join(root, 'sub'));
  assert.equal(result.stderr.trim(), 'world');
});

test('command/exec validates its arguments like Codex', async (t) => {
  const root = await tmp(t);
  const { host } = hostFor(root);
  await assert.rejects(host.handle('command/exec', { command: [] }), /non-empty/);
  await assert.rejects(host.handle('command/exec', { command: ['true'], streamStdin: true }), /processId is required/);
  await assert.rejects(host.handle('command/exec', { command: ['true'], size: { rows: 1, cols: 1 } }), /only valid when tty/);
  await assert.rejects(host.handle('command/exec', { command: ['true'], outputBytesCap: 1, disableOutputCap: true }), /cannot be combined/);
  await assert.rejects(host.handle('command/exec', { command: ['true'], timeoutMs: 1, disableTimeout: true }), /cannot be combined/);
  await assert.rejects(host.handle('command/exec', { command: ['true'], sandboxPolicy: { type: 'dangerFullAccess' } }), /not supported/);
  await assert.rejects(host.handle('command/exec', { command: ['true'], cwd: os.tmpdir() === root ? '/' : os.tmpdir() }), (error) => error.rpc.code === -32001);
  await assert.rejects(host.handle('command/exec', { command: ['definitely-not-a-command-oasis'] }), /Command not found/);
});

test('command/exec streams stdin and output deltas, honours the output cap, and the final response comes last', async (t) => {
  const root = await tmp(t);
  const { host, notes } = hostFor(root);
  const done = host.handle('command/exec', { command: [process.execPath, '-e', 'process.stdin.on("data", d => process.stdout.write(String(d).toUpperCase())); process.stdin.on("end", () => process.stdout.write("!".repeat(50)))'], processId: 'p1', streamStdin: true, streamStdoutStderr: true, outputBytesCap: 10 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await host.handle('command/exec/write', { processId: 'p1', deltaBase64: b64('abc') });
  await host.handle('command/exec/write', { processId: 'p1', closeStdin: true });
  const result = await done;
  assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
  const deltas = notes.filter((note) => note.method === 'command/exec/outputDelta' && note.params.stream === 'stdout');
  const text = deltas.map((note) => unb64(note.params.deltaBase64)).join('');
  assert.equal(text, 'ABC!!!!!!!');
  assert.equal(deltas.at(-1).params.capReached, true);
  assert.ok(deltas.every((note) => note.params.processId === 'p1'));
  await assert.rejects(host.handle('command/exec/write', { processId: 'p1', deltaBase64: b64('x') }), /No running process/);
});

test('command/exec/terminate and timeouts stop the process', async (t) => {
  const root = await tmp(t);
  const { host } = hostFor(root);
  const started = Date.now();
  const running = host.handle('command/exec', { command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], processId: 'long', streamStdoutStderr: true });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await assert.rejects(host.handle('command/exec', { command: ['true'], processId: 'long' }), /already running/);
  await host.handle('command/exec/terminate', { processId: 'long' });
  const result = await running;
  assert.notEqual(result.exitCode, 0);
  assert.ok(Date.now() - started < 5000);
  const timed = await host.handle('command/exec', { command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], timeoutMs: 200 });
  assert.notEqual(timed.exitCode, 0);
  assert.match(timed.stderr, /timed out after 200 ms/);
});

test('command/exec goes through the configured sandbox launcher', async (t) => {
  const root = await tmp(t);
  const calls = [];
  const sandbox = { enabled: true, available: true, kind: 'fake' };
  const { host } = hostFor(root, {
    getSandbox: async (cwd) => { calls.push(['sandbox', cwd]); return sandbox; },
    launch: async (command, args, box, cwd) => { calls.push(['launch', command, args, box, cwd]); return { command: process.execPath, args: ['-e', 'process.stdout.write("wrapped")'] }; }
  });
  const result = await host.handle('command/exec', { command: ['echo', 'hi'] });
  assert.equal(result.stdout, 'wrapped');
  assert.deepEqual(calls, [['sandbox', root], ['launch', 'echo', ['hi'], sandbox, root]]);
  const refusing = hostFor(root, { getSandbox: async () => ({ enabled: true, available: false, reason: 'no bwrap' }), launch: async () => { throw new Error('The OS sandbox is enabled but unavailable; refusing to run commands without isolation. no bwrap'); } }).host;
  await assert.rejects(refusing.handle('command/exec', { command: ['true'] }), /refusing to run/);
});

test('tty mode reports a clear error when node-pty is missing, and resize needs a tty', async (t) => {
  const root = await tmp(t);
  const missing = Object.assign(new Error('Cannot find package node-pty'), { code: 'ERR_MODULE_NOT_FOUND' });
  const { host } = hostFor(root, { loadPty: async () => { throw missing; } });
  await assert.rejects(host.handle('command/exec', { command: ['sh'], processId: 't', tty: true }), /node-pty/);
  const pending = host.handle('command/exec', { command: [process.execPath, '-e', 'setTimeout(() => {}, 300)'], processId: 'np', streamStdoutStderr: true });
  await assert.rejects(host.handle('command/exec/resize', { processId: 'np', size: { rows: 10, cols: 10 } }), /Only tty/);
  await pending;
});

test('tty mode drives a fake PTY: output, input, resize, exit code', async (t) => {
  const root = await tmp(t);
  const events = [];
  let onData = null;
  let onExit = null;
  const fakePty = {
    spawn: (command, args, opts) => {
      events.push(['spawn', command, args, opts.cols, opts.rows, opts.cwd]);
      return {
        onData: (fn) => { onData = fn; },
        onExit: (fn) => { onExit = fn; },
        write: (data) => { events.push(['write', data]); onData('echo:' + data); if (data === 'exit') onExit({ exitCode: 7 }); },
        resize: (cols, rows) => events.push(['resize', cols, rows]),
        kill: () => events.push(['kill'])
      };
    }
  };
  const { host, notes } = hostFor(root, { loadPty: async () => fakePty });
  const done = host.handle('command/exec', { command: ['bash'], processId: 'tty1', tty: true, size: { rows: 30, cols: 100 } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await host.handle('command/exec/resize', { processId: 'tty1', size: { rows: 40, cols: 120 } });
  await host.handle('command/exec/write', { processId: 'tty1', deltaBase64: b64('ls') });
  await host.handle('command/exec/write', { processId: 'tty1', deltaBase64: b64('exit') });
  const result = await done;
  assert.equal(result.exitCode, 7);
  assert.deepEqual(events[0], ['spawn', 'bash', [], 100, 30, root]);
  assert.ok(events.some((event) => event[0] === 'resize' && event[1] === 120 && event[2] === 40));
  const output = notes.filter((note) => note.method === 'command/exec/outputDelta').map((note) => unb64(note.params.deltaBase64)).join('');
  assert.equal(output, 'echo:lsecho:exit');
});

test('the App Server routes fs/* and command/exec after initialize and adds thread roots', async (t) => {
  const root = await tmp(t);
  const lines = [];
  const server = createCodexAppServer({ cwd: root, env: { HOME: root, OASIS_SANDBOX: '0', PATH: process.env.PATH }, write: (line) => lines.push(JSON.parse(line)), log: () => {} });
  t.after(() => server.close());
  const call = async (id, method, params) => { await server.receive(JSON.stringify({ id, method, params })); return lines.find((line) => line.id === id); };
  const early = await call(1, 'fs/readDirectory', { path: root });
  assert.equal(early.error.code, -32600);
  await call(2, 'initialize', { clientInfo: { name: 'test' } });
  await writeFile(path.join(root, 'x.txt'), 'data');
  const listing = await call(3, 'fs/readDirectory', { path: root });
  assert.deepEqual(listing.result.entries.map((entry) => entry.fileName), ['x.txt']);
  const ran = await call(4, 'command/exec', { command: [process.execPath, '-e', 'process.stdout.write("ok")'] });
  assert.deepEqual(ran.result, { exitCode: 0, stdout: 'ok', stderr: '' });
  const missing = await call(5, 'fs/nope', {});
  assert.equal(missing.error.code, -32601);
});

test('fuzzyFileSearch ranks files and folders inside allowed roots, skips secrets, honours cancellation tokens', async (t) => {
  const root = await tmp(t);
  await mkdir(path.join(root, 'src', 'agent'), { recursive: true });
  await writeFile(path.join(root, 'src', 'agent', 'loop.mjs'), 'x');
  await writeFile(path.join(root, 'src', 'cli.mjs'), 'x');
  await writeFile(path.join(root, 'README.md'), 'x');
  await writeFile(path.join(root, '.env'), 'SECRET=1');
  const { host } = hostFor(root);
  assert.ok(host.has('fuzzyFileSearch'));
  const { files } = await host.handle('fuzzyFileSearch', { query: 'cli', roots: [root] });
  assert.equal(files[0].path, 'src/cli.mjs');
  assert.deepEqual(Object.keys(files[0]).sort(), ['file_name', 'indices', 'match_type', 'path', 'root', 'score']);
  assert.equal(files[0].file_name, 'cli.mjs');
  assert.equal(files[0].match_type, 'file');
  assert.equal(files[0].root, root);
  assert.deepEqual(files[0].indices, [4, 5, 6]);
  const agent = await host.handle('fuzzyFileSearch', { query: 'agent', roots: [root] });
  assert.ok(agent.files.some((f) => f.path === 'src/agent' && f.match_type === 'directory'));
  const loose = await host.handle('fuzzyFileSearch', { query: 'salp', roots: [root] });
  assert.equal(loose.files[0].path, 'src/agent/loop.mjs');
  assert.equal((await host.handle('fuzzyFileSearch', { query: 'env', roots: [root] })).files.length, 0);
  assert.deepEqual(await host.handle('fuzzyFileSearch', { query: '', roots: [root] }), { files: [] });
  await assert.rejects(host.handle('fuzzyFileSearch', { query: 'x', roots: [os.tmpdir()] }), (e) => e.rpc.code === -32001);
  await assert.rejects(host.handle('fuzzyFileSearch', { query: 'x' }), (e) => e.rpc.code === -32602);
  const [first, second] = await Promise.all([
    host.handle('fuzzyFileSearch', { query: 'mjs', roots: [root], cancellationToken: 'picker' }),
    host.handle('fuzzyFileSearch', { query: 'mjs', roots: [root], cancellationToken: 'picker' })
  ]);
  assert.deepEqual(first, { files: [] });
  assert.ok(second.files.length >= 2);
});

test('gitDiffToRemote: nearest pushed commit and the diff from it, untracked files included', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const base = await tmp(t, 'oasis-host-git-');
  const remote = path.join(base, 'remote.git');
  const root = path.join(base, 'work');
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const run = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
  run(base, 'init', '-q', '--bare', remote);
  await mkdir(root);
  run(root, 'init', '-q', '-b', 'main');
  const { host } = hostFor(root);
  await assert.rejects(host.handle('gitDiffToRemote', { cwd: root }), /no remotes/);
  await writeFile(path.join(root, 'a.txt'), 'one\n');
  run(root, 'add', '.'); run(root, 'commit', '-qm', 'first');
  run(root, 'remote', 'add', 'origin', remote);
  await assert.rejects(host.handle('gitDiffToRemote', { cwd: root }), /No commit in HEAD's history is on a remote/);
  run(root, 'push', '-q', 'origin', 'main');
  const pushed = run(root, 'rev-parse', 'HEAD');
  // A local-only commit, an uncommitted edit and an untracked file.
  await writeFile(path.join(root, 'b.txt'), 'local commit\n');
  run(root, 'add', '.'); run(root, 'commit', '-qm', 'local');
  await writeFile(path.join(root, 'a.txt'), 'one\ntwo\n');
  await writeFile(path.join(root, '-new file.txt'), 'untracked\n');
  const result = await host.handle('gitDiffToRemote', { cwd: root });
  assert.equal(result.sha, pushed);
  assert.match(result.diff, /\+local commit/);
  assert.match(result.diff, /\+two/);
  assert.match(result.diff, /\+untracked/);
  assert.match(result.diff, /-new file\.txt/);
  // The patch reproduces the checkout on top of the pushed commit.
  const clone = path.join(base, 'clone');
  run(base, 'clone', '-q', remote, clone);
  run(clone, 'checkout', '-q', result.sha);
  execFileSync('git', ['apply', '-'], { cwd: clone, env: gitEnv, input: result.diff });
  assert.equal(await readFile(path.join(clone, 'a.txt'), 'utf8'), 'one\ntwo\n');
  assert.equal(await readFile(path.join(clone, 'b.txt'), 'utf8'), 'local commit\n');
  assert.equal(await readFile(path.join(clone, '-new file.txt'), 'utf8'), 'untracked\n');
  // A folder outside the allowed roots is refused.
  await assert.rejects(host.handle('gitDiffToRemote', { cwd: base }), (error) => error.rpc && error.rpc.code === -32001);
});
