// Claude Code's `mcp add-json NAME JSON` and `mcp get NAME` were "Unknown MCP
// action"; a refused `mcp add` exited 0; `mcp list` printed remote URLs with
// their query string (which can carry a key).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/oasis.mjs');

function oasis(args, home, cwd) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_NO_UPDATE_CHECK: '1' };
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

test('mcp add-json, get and list (secrets hidden), and refused adds fail', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-addjson-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'oasis-addjson-proj-'));
  t.after(async () => { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }); });
  let r = await oasis(['mcp', 'add-json', 'api', '{"type":"http","url":"https://example.com/mcp?key=abc123","headers":{"Authorization":"Bearer sekrit-value"}}', '--yes'], home, project);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /sekrit-value|abc123/);
  r = await oasis(['mcp', 'add-json', 'fs', '{"command":"npx","args":["-y","some-server"],"env":{"FS_TOKEN":"tok-value-1"}}', '--yes'], home, project);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Environment: FS_TOKEN \(values hidden\)/);
  assert.doesNotMatch(r.out, /tok-value-1/);
  const saved = JSON.parse(await readFile(path.join(home, '.config', 'oasis', 'mcp.json'), 'utf8'));
  assert.deepEqual(saved.mcpServers.fs, { command: 'npx', args: ['-y', 'some-server'], env: { FS_TOKEN: 'tok-value-1' } });
  assert.equal(saved.mcpServers.api.url, 'https://example.com/mcp?key=abc123');

  r = await oasis(['mcp', 'get', 'fs'], home, project);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Type: stdio/);
  assert.match(r.out, /Args: \["-y","some-server"\]/);
  assert.doesNotMatch(r.out, /tok-value-1/);
  r = await oasis(['mcp', 'get', 'api'], home, project);
  assert.match(r.out, /URL: https:\/\/example\.com\/mcp\?…/);
  assert.doesNotMatch(r.out, /abc123|sekrit-value/);
  r = await oasis(['mcp', 'get', 'missing'], home, project);
  assert.equal(r.code, 1);
  r = await oasis(['mcp', 'list'], home, project);
  assert.doesNotMatch(r.out, /abc123/);
  assert.match(r.out, /api — http https:\/\/example\.com\/mcp\?…/);

  // Literal credentials are refused for the (usually committed) project file.
  r = await oasis(['mcp', 'add-json', 'pj', '{"command":"echo","env":{"API_KEY":"literal"}}', '--scope', 'project', '--yes'], home, project);
  assert.equal(r.code, 1);
  assert.match(r.out, /would put a credential in \.mcp\.json/);
  // Without a terminal or --yes nothing is added, and the exit code says so.
  r = await oasis(['mcp', 'add-json', 'later', '{"command":"echo"}'], home, project);
  assert.equal(r.code, 1, r.out);
  r = await oasis(['mcp', 'add', 'later2', '--', 'echo', 'hi'], home, project);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /cancelled/);
});
