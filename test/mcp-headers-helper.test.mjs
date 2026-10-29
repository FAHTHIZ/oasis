import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { McpHttpClient, parseMcpServerEntries } from '../src/mcp-project.mjs';

test('parseMcpServerEntries keeps headersHelper and rejects bad values', () => {
  const ok = parseMcpServerEntries({ mcpServers: { api: { type: 'http', url: 'https://mcp.example.com/mcp', headersHelper: './get-token.sh' } } });
  assert.equal(ok.servers[0].headersHelper, './get-token.sh');
  const bad = parseMcpServerEntries({ mcpServers: { api: { type: 'http', url: 'https://mcp.example.com/mcp', headersHelper: 42 } } });
  assert.match(bad.failures[0].error, /headersHelper/);
});

test('headersHelper headers are sent and refreshed after a 401', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-hh-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const counter = path.join(dir, 'count');
  const helper = path.join(dir, 'helper.mjs');
  await writeFile(helper, "import fs from 'node:fs';\nconst f = " + JSON.stringify(counter) + ";\nconst n = (fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0) + 1;\nfs.writeFileSync(f, String(n));\nprocess.stdout.write(JSON.stringify({ Authorization: 'Bearer token-' + n, 'X-Server': process.env.CLAUDE_CODE_MCP_SERVER_NAME + '@' + process.env.CLAUDE_CODE_MCP_SERVER_URL }));\n");
  const seen = [];
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fakeFetch = async (_url, init) => {
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    seen.push({ ...init.headers });
    if (init.headers.Authorization === 'Bearer token-1' && seen.length > 2) return new Response('expired', { status: 401 });
    const message = JSON.parse(init.body);
    if (message.method === 'initialize') return json({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } });
    if (message.method === 'tools/list') return json({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } });
    if (message.method === 'tools/call') return json({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'hi' }] } });
    return new Response(null, { status: 202 });
  };
  const client = new McpHttpClient({ name: 'api', url: 'https://mcp.example.com/mcp', headers: { 'X-Static': 's' }, headersHelper: JSON.stringify(process.execPath) + ' ' + JSON.stringify(helper) }, { fetch: fakeFetch, env: { ...process.env, OASIS_CONFIG_DIR: dir } });
  t.after(() => client.close());
  await client.start();
  assert.equal(seen[0].Authorization, 'Bearer token-1');
  assert.equal(seen[0]['X-Static'], 's');
  assert.equal(seen[0]['X-Server'], 'api@https://mcp.example.com/mcp');
  const result = await client.callTool('echo', {}, { autoApprove: true });
  assert.match(result.content, /hi/);
  assert.equal(seen[seen.length - 1].Authorization, 'Bearer token-2');
});

function helperCommand(helper) {
  return JSON.stringify(process.execPath) + ' ' + JSON.stringify(helper);
}

async function createHelperFixture(t, buildScript, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-hh-bound-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const helper = path.join(dir, 'helper.mjs');
  const pidFile = path.join(dir, 'helper.pid');
  await writeFile(helper, buildScript(pidFile));
  const client = new McpHttpClient({
    name: 'api',
    url: 'https://mcp.example.com/mcp',
    headersHelper: helperCommand(helper)
  }, {
    env: { ...process.env, OASIS_CONFIG_DIR: dir },
    ...options
  });
  t.after(() => client.close());
  return { client, dir, pidFile };
}

async function waitForFile(file, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await readFile(file, 'utf8'); return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('headersHelper did not create its start marker');
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code !== 'ESRCH';
  }
}

async function waitForProcessExit(pid, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('headersHelper process ' + pid + ' survived termination');
}

test('headersHelper bounds stdout by bytes and terminates the process tree on overflow', async (t) => {
  const { client, pidFile } = await createHelperFixture(
    t,
    (marker) => "import fs from 'node:fs'; fs.writeFileSync(" + JSON.stringify(marker) + ", String(process.pid)); process.stdout.write('x'.repeat(70000)); setInterval(() => {}, 1000);",
    { headersHelperTimeoutMs: 5000 }
  );
  await assert.rejects(client._helperHeaders(), /headersHelper output exceeded 64 KiB/);
  await waitForFile(pidFile);
  await waitForProcessExit(Number(await readFile(pidFile, 'utf8')));
});

test('headersHelper uses a bounded timeout and kills a looping helper process', async (t) => {
  const { client, pidFile } = await createHelperFixture(
    t,
    (marker) => "import fs from 'node:fs'; fs.writeFileSync(" + JSON.stringify(marker) + ", String(process.pid)); setInterval(() => {}, 1000);",
    { headersHelperTimeoutMs: 1000 }
  );
  await assert.rejects(client._helperHeaders(), /headersHelper timed out after 1s/);
  await waitForFile(pidFile);
  await waitForProcessExit(Number(await readFile(pidFile, 'utf8')));
});

test('closing an MCP client terminates an in-flight headersHelper', async (t) => {
  const { client, pidFile } = await createHelperFixture(
    t,
    (marker) => "import fs from 'node:fs'; fs.writeFileSync(" + JSON.stringify(marker) + ", String(process.pid)); setInterval(() => {}, 1000);",
    { headersHelperTimeoutMs: 5000 }
  );
  const pending = client._helperHeaders();
  await waitForFile(pidFile);
  const pid = Number(await readFile(pidFile, 'utf8'));
  client.close();
  await assert.rejects(pending, /MCP server session closed/);
  await waitForProcessExit(pid);
});
