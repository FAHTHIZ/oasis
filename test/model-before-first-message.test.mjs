// Regression: `/model NAME` before the first message said "No active session"
// (also when NAME was picked from the /model picker), and the picker offered
// Claude aliases (opus, sonnet, ...) to an OpenAI-compatible server that would
// receive the literal name. Driven through a real pseudo-terminal.
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

const DRIVER = String.raw`
import os, pty, sys, time, select, fcntl, termios, struct
pid, fd = pty.fork()
if pid == 0:
    os.chdir(sys.argv[1])
    os.execvp(sys.argv[2], sys.argv[2:])
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
def send(text):
    for ch in text: os.write(fd, ch.encode()); time.sleep(0.01)
pump(20, b'\x1b[?2004h')
pump(1)
send('/model other-model\r')
pump(20, b'Model set to')
pump(1)
send('hi\r')
pump(30, b'Done')
pump(0.5)
sys.stdout.buffer.write(buf)
try: os.kill(pid, 9)
except Exception: pass
`;

test('/model NAME before the first message switches the model for that conversation', { skip: !hasPty && 'needs python3 pty', timeout: 120000 }, async (t) => {
  const models = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [] })); return; }
    try { models.push(JSON.parse(body).model); } catch {}
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-model-early-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'oasis-model-early-proj-'));
  t.after(async () => { server.close(); await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }); });
  await mkdir(path.join(home, '.config', 'oasis'), { recursive: true });
  await writeFile(path.join(home, '.config', 'oasis', 'config.json'), JSON.stringify({ protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'first-model', keyless: true }));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_NO_UPDATE_CHECK: '1', TERM: 'xterm-256color', NO_COLOR: '1' };
  for (const key of Object.keys(env)) if (/^OASIS_(MODEL|BASE_URL|PROTOCOL|LOCAL_API_KEY)$|_API_KEY$/.test(key)) delete env[key];
  delete env.OASIS_PLAIN_OUTPUT;
  const raw = await new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', DRIVER, project, process.execPath, path.join(ROOT, 'src', 'oasis.mjs')], { env });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', reject);
    child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
  const plain = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
  assert.doesNotMatch(plain, /No active session/);
  assert.match(plain, /Model set to other-model/);
  assert.ok(models.length > 0, 'the task reached the model server\n' + plain.slice(-1500));
  assert.equal(models[0], 'other-model');
});

test('the /model picker offers no Claude aliases to an OpenAI-compatible provider', async () => {
  const { pickerFor } = await import('../src/select-dialog.mjs');
  // The provider list could not be fetched (OASIS_MODEL_PICKER_FETCH=0): only the
  // current model is left, so the plain /model reply is shown instead.
  const session = { config: { model: 'gpt-oss-20b', protocol: 'openai-compatible' } };
  assert.equal(await pickerFor('model', { session, env: { OASIS_MODEL_PICKER_FETCH: '0' } }), null);
  // Claude providers still get the aliases.
  const claude = await pickerFor('model', { session: { config: { model: 'sonnet', protocol: 'anthropic' } }, env: { OASIS_MODEL_PICKER_FETCH: '0' } });
  assert.ok(claude.options.some((o) => o.value === 'opus'));
});
