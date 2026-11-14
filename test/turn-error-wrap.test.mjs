// Regression: a failed turn printed "OASIS error: ..." unwrapped, so the
// terminal broke words across rows ("ref" / "used"). Driven through a real
// pseudo-terminal 60 columns wide.
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
const WORDS = 'The requested configuration is unsupported because the selected deployment does not accept extraordinarily lengthy parameters here';

const DRIVER = String.raw`
import os, pty, sys, time, select, fcntl, termios, struct
pid, fd = pty.fork()
if pid == 0:
    os.chdir(sys.argv[2])
    os.execvp(sys.argv[3], sys.argv[3:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 60, 0, 0))
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
pump(30, b'tool-calling support.')
pump(0.5)
sys.stdout.buffer.write(buf)
try: os.kill(pid, 9)
except Exception: pass
`;

test('a failed turn wraps its error message at word boundaries', { skip: !hasPty && 'needs python3 pty', timeout: 90000 }, async (t) => {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    if (req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'mock' }] })); return; }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: WORDS } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-errwrap-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'oasis-errwrap-proj-'));
  t.after(async () => { server.close(); await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }); });
  await mkdir(path.join(home, '.config', 'oasis'), { recursive: true });
  await writeFile(path.join(home, '.config', 'oasis', 'config.json'), JSON.stringify({ protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'mock', keyless: true, contextWindow: 131072 }));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_NO_UPDATE_CHECK: '1', TERM: 'xterm-256color', NO_COLOR: '1' };
  delete env.OPENAI_API_KEY; delete env.ANTHROPIC_API_KEY; delete env.OASIS_PLAIN_OUTPUT;
  const raw = await new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', DRIVER, 'fix it', project, process.execPath, path.join(ROOT, 'src', 'oasis.mjs')], { env });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', reject);
    child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
  const plain = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
  const at = plain.indexOf('OASIS error:');
  assert.ok(at >= 0, 'the error was printed\n' + plain.slice(-1200));
  const rows = plain.slice(at, plain.indexOf('support.', at) + 8).split(/\r?\n/);
  assert.ok(rows.length > 2, 'the message spans several rows');
  for (const row of rows) assert.ok(row.length <= 60, 'row fits 60 columns: ' + JSON.stringify(row));
  // Re-joining the rows with spaces gives back every word intact.
  const joined = rows.map((row) => row.trim()).join(' ');
  assert.ok(joined.includes(WORDS), 'no word was split across rows:\n' + rows.join('\n'));
});
