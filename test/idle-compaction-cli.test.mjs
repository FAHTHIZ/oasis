import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

test('the interactive terminal compacts a long conversation while you are idle', { skip: process.platform !== 'linux' }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-idle-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const text = JSON.stringify(payload.messages);
    const summary = !payload.tools && /summar/i.test(String(payload.messages[0] && payload.messages[0].content));
    requests.push({ summary, chars: text.length, at: Date.now() });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: summary ? 'IDLE-SUMMARY of the earlier work' : 'reply ' + requests.filter((r) => !r.summary).length } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const big = (letter) => 'note ' + letter.repeat(16000);
  const command = [process.execPath, cli, big('a')].map((part) => JSON.stringify(part)).join(' ');
  const child = spawn('script', ['-qfec', command, '/dev/null'], { cwd: home, env: { ...process.env, OASIS_NO_STREAM: '1', OASIS_DISABLE_THEME_RELOAD: '1', HOME: home, OASIS_CONFIG_DIR: path.join(home, '.oasis'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/v1', OASIS_MODEL: 'fixture', OASIS_API_KEY: '', OASIS_IDLE_COMPACT_MINUTES: '0.03', OASIS_COMPACT_THRESHOLD_CHARS: '90000', OASIS_SOUNDS: 'off', OASIS_NOTIFY: 'off', OASIS_BACKGROUND_NOTICE: '0' } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  // The default line editor, typed through a pseudo-terminal: Enter is \r.
  const timer = setTimeout(() => child.kill(), 90000);
  const steps = [['reply 1', big('b')], ['reply 2', big('c')], ['reply 3', null], ['IDLE-WAIT', 'after the break'], ['reply 4', '/exit']];
  let step = 0; let idleSince = 0;
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      if (step >= steps.length) { clearInterval(iv); resolve(); return; }
      const [marker, input] = steps[step];
      if (marker === 'IDLE-WAIT') {
        if (idleSince && requests.some((r) => r.summary && r.at >= idleSince) && Date.now() - idleSince > 500) { child.stdin.write(input + '\r'); step++; }
        return;
      }
      if (out.includes(marker)) { if (input) child.stdin.write(input + '\r'); else idleSince = Date.now(); step++; }
    }, 50);
    child.on('exit', () => { clearInterval(iv); resolve(); });
  });
  await new Promise((resolve) => child.exitCode !== null ? resolve() : child.on('exit', resolve));
  clearTimeout(timer);
  assert.ok(requests.some((r) => r.summary), 'a summary request was sent while idle\n' + out.slice(-2000));
  assert.match(out, /While you were away, older history was summarized/);
  const turns = requests.filter((r) => !r.summary);
  const last = turns.at(-1); const beforeBreak = turns.at(-2);
  assert.ok(!/Compacting 2 older/.test(out.split('After the break')[0] || ''), 'no normal compaction during the turns');
  assert.ok(last.chars < beforeBreak.chars - 10000, 'the turn after the break sent the compacted history (' + beforeBreak.chars + ' -> ' + last.chars + ' chars)');
  assert.match(out, /reply 4/);
});
