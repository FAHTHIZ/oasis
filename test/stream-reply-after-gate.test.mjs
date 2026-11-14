// Regression: when a gate re-prompts the model after a streamed reply (here an
// open todo), the first reply's last line must end before the next request's
// spinner clears the row, and the next reply must not be diffed against the
// old text (its first chunk was dropped: " funct" + "ion add ..." showed as
// "ask!ion add"). Driven through a real pseudo-terminal at a known size.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasPty = process.platform !== 'win32' && spawnSync('python3', ['-c', 'import pty, fcntl, termios'], { stdio: 'ignore' }).status === 0;

const A = 'The function `add` in `math.mjs` is correct. No changes are needed.\n\nIf you need further assistance, feel free to ask!';
const B = ' function `add` in `math.mjs` returns the sum.';

const DRIVER = String.raw`
import os, pty, sys, time, select, fcntl, termios, struct
pid, fd = pty.fork()
if pid == 0:
    os.chdir(sys.argv[2])
    os.execvp(sys.argv[3], sys.argv[3:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
buf = b''
def pump(t, until=None):
    global buf
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try: buf += os.read(fd, 65536)
            except OSError: return
        if until and until in buf: return
pump(20, b'\x1b[?2004h')
pump(1.5)
os.write(fd, sys.argv[1].encode() + b'\r')
pump(40, b'Chat saved')
pump(0.5)
sys.stdout.buffer.write(buf)
try: os.kill(pid, 9)
except Exception: pass
`;

test('a reply streamed after a gate re-prompt starts on its own line with its first words', { skip: !hasPty && 'needs python3 pty', timeout: 90000 }, async (t) => {
  let n = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    if (req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'mock' }] })); return; }
    n += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
    if (n === 1) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: 'Check add', status: 'in_progress' }] }) } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      const text = n === 2 ? A : n === 3 ? B : 'Done.';
      for (let i = 0; i < text.length; i += 6) { send({ choices: [{ delta: { content: text.slice(i, i + 6) } }] }); await new Promise((r) => setTimeout(r, 5)); }
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-gate-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'oasis-gate-proj-'));
  t.after(async () => { server.close(); await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }); });
  await mkdir(path.join(home, '.config', 'oasis'), { recursive: true });
  await writeFile(path.join(home, '.config', 'oasis', 'config.json'), JSON.stringify({ protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'mock', keyless: true, contextWindow: 131072 }));
  await writeFile(path.join(project, 'math.mjs'), 'export const add = (a, b) => a + b;\n');
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_NO_UPDATE_CHECK: '1', TERM: 'xterm-256color' };
  delete env.NO_COLOR; delete env.OPENAI_API_KEY; delete env.ANTHROPIC_API_KEY; delete env.OASIS_PLAIN_OUTPUT; delete env.OASIS_NO_STREAM;
  const raw = await new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', DRIVER, 'Check add in math.mjs', project, process.execPath, path.join(ROOT, 'src', 'oasis.mjs')], { env });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', reject);
    child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
  assert.ok(n >= 3, 'the gate re-prompted the model (requests: ' + n + ')\n' + raw.slice(-1500));
  const plain = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
  assert.doesNotMatch(plain, /ask!ion/, 'the second reply continued on the first reply\'s last line');
  // The rendered second reply keeps its first chunk and sits on a new line after "ask!".
  assert.match(plain, /feel free to ask!\r?\n[\s\S]*●\s*function add in math\.mjs returns the sum\./);
});

