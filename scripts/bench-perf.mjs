#!/usr/bin/env node
// Runtime performance with no model and no network: CLI launch time and peak
// memory, the cost of loading the agent runtime and creating a session with
// the default tools, the web workspace's memory idle and after serving the
// app, task-routing overhead, and stdio MCP server startup. Each measurement
// that loads code runs in a fresh Node process, so module caches are cold.
//   npm run bench:perf -- [--runs N] [--json FILE]
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repoRoot, 'src', 'oasis.mjs');

export function parseArgs(argv) {
  const options = { runs: 7, json: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { ...options, help: true };
    if (arg === '--runs' && argv[i + 1]) { options.runs = Number(argv[++i]); continue; }
    if (arg === '--json' && argv[i + 1]) { options.json = argv[++i]; continue; }
    throw new Error('Unknown or incomplete option: ' + arg);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 50) throw new Error('--runs must be 1-50.');
  return options;
}

export function summarize(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  return { runs: sorted.length, median: at(0.5), p90: at(0.9), min: sorted[0], max: sorted[sorted.length - 1] };
}

const round = (value, digits = 1) => (value === null || value === undefined ? null : Number(value.toFixed(digits)));
const mb = (bytes) => round(bytes / (1024 * 1024));

// A preload that reports the process's peak resident memory when it exits
// (process.resourceUsage().maxRSS is in kilobytes on every platform).
const PEAK_HOOK = "import { writeFileSync } from 'node:fs';\nprocess.on('exit', () => { try { writeFileSync(process.env.OASIS_PERF_PEAK, String(process.resourceUsage().maxRSS * 1024)); } catch {} });\n";

function run(command, args, { env, cwd, input } = {}) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr, ms: Number(process.hrtime.bigint() - started) / 1e6 }));
    child.stdin.end(input || '');
  });
}

async function scratch() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-perf-'));
  const home = path.join(dir, 'home');
  const work = path.join(dir, 'work');
  await mkdir(home, { recursive: true });
  await mkdir(work, { recursive: true });
  await writeFile(path.join(work, 'package.json'), '{"name":"perf-fixture","type":"module"}\n');
  const hook = path.join(dir, 'peak.mjs');
  await writeFile(hook, PEAK_HOOK);
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_CONFIG_DIR: path.join(home, '.oasis'), OASIS_NO_UPDATE_CHECK: '1', OASIS_TELEMETRY: '0', OASIS_NO_MASCOT: '1', NO_COLOR: '1' };
  for (const name of Object.keys(env)) if (/(_API_KEY|_TOKEN|^OASIS_MODEL$|^OASIS_BASE_URL$)/.test(name)) delete env[name];
  return { dir, home, work, hook, env };
}

async function launch(box, args, runs) {
  const times = [];
  const peaks = [];
  for (let i = 0; i < runs; i += 1) {
    const peakFile = path.join(box.dir, 'peak-' + i);
    const result = await run(process.execPath, ['--import', pathToFileURL(box.hook).href, cli, ...args], { env: { ...box.env, OASIS_PERF_PEAK: peakFile }, cwd: box.work });
    if (result.status !== 0) throw new Error('oasis ' + args.join(' ') + ' exited ' + result.status + ': ' + result.stderr.slice(0, 400));
    times.push(result.ms);
    peaks.push(Number(await readFile(peakFile, 'utf8').catch(() => 'NaN')));
  }
  return { args: args.join(' '), wallMs: summarize(times), peakRssMb: summarize(peaks.map(mb)) };
}

// Runs in a child: import the runtime, create a session the way `oasis -p`
// does, report timings, tool count, prompt size and memory.
const SESSION_PROBE = `
const t0 = performance.now();
const agent = await import(process.env.OASIS_PERF_AGENT);
const t1 = performance.now();
const { countTextTokens } = await import(process.env.OASIS_PERF_TOKENS);
globalThis.fetch = async (url) => { throw new Error('perf: unexpected network request to ' + url); };
const config = { protocol: 'openai-compatible', baseURL: 'https://perf.invalid/v1', model: 'gpt-oss-120b', apiKey: 'perf-key', maxSteps: 40 };
const session = await agent.createSession({ root: process.cwd(), config, env: process.env });
const t2 = performance.now();
const tools = session.toolDefinitions || [];
const system = String(session.messages && session.messages[0] && session.messages[0].content || '');
const out = { importMs: t1 - t0, sessionMs: t2 - t1, tools: tools.length, systemTokens: countTextTokens(system), toolTokens: countTextTokens(JSON.stringify(tools)), rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed };
agent.closeSession(session);
process.stdout.write(JSON.stringify(out));
process.exit(0);
`;

async function sessionCost(box, runs) {
  const probe = path.join(box.dir, 'session-probe.mjs');
  await writeFile(probe, SESSION_PROBE);
  const rows = [];
  for (let i = 0; i < runs; i += 1) {
    const result = await run(process.execPath, [probe], { env: { ...box.env, OASIS_PERF_AGENT: pathToFileURL(path.join(repoRoot, 'src', 'agent.mjs')).href, OASIS_PERF_TOKENS: pathToFileURL(path.join(repoRoot, 'src', 'tokens.mjs')).href }, cwd: box.work });
    if (result.status !== 0) throw new Error('session probe failed: ' + result.stderr.slice(0, 600));
    rows.push(JSON.parse(result.stdout));
  }
  const last = rows[rows.length - 1];
  return { importMs: summarize(rows.map((row) => row.importMs)), createSessionMs: summarize(rows.map((row) => row.sessionMs)), rssMb: summarize(rows.map((row) => mb(row.rss))), heapUsedMb: summarize(rows.map((row) => mb(row.heapUsed))), tools: last.tools, firstRequestTokens: { system: last.systemTokens, toolSchemas: last.toolTokens, total: last.systemTokens + last.toolTokens } };
}

async function rssOf(pid) {
  try {
    const status = await readFile('/proc/' + pid + '/status', 'utf8');
    const match = /VmRSS:\s+(\d+) kB/.exec(status);
    return match ? Number(match[1]) * 1024 : null;
  } catch { return null; }
}

// The web workspace: memory once it listens and is idle, and after it has
// served the app shell and its assets a few times.
async function webMemory(box) {
  if (process.platform !== 'linux') return { skipped: 'reads /proc; Linux only' };
  const child = spawn(process.execPath, [cli, 'web', '--port', '0'], { env: box.env, cwd: box.work, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const url = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 30000);
    const onData = (chunk) => {
      output += chunk;
      const match = /(https?:\/\/(?:127\.0\.0\.1|localhost):\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', () => { clearTimeout(timer); resolve(null); });
  });
  try {
    if (!url) return { skipped: 'web workspace did not report an address: ' + output.slice(0, 300) };
    const listenedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const idle = await rssOf(child.pid);
    let served = 0;
    for (let i = 0; i < 5; i += 1) {
      const page = await fetch(url + '/').catch(() => null);
      if (!page) continue;
      const html = await page.text();
      served += html.length;
      for (const [, asset] of html.matchAll(/(?:src|href)="(\/[^"#?]+\.(?:js|mjs|css))"/g)) {
        const response = await fetch(url + asset).catch(() => null);
        if (response) served += (await response.arrayBuffer()).byteLength;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const after = await rssOf(child.pid);
    return { idleRssMb: idle === null ? null : mb(idle), afterServingRssMb: after === null ? null : mb(after), servedKb: round(served / 1024), idleAfterMs: Date.now() - listenedAt };
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('close', resolve); setTimeout(resolve, 5000); });
  }
}

async function routingOverhead() {
  const { selectTaskModel } = await import(pathToFileURL(path.join(repoRoot, 'src', 'model-routing.mjs')).href);
  const routing = { enabled: true, easyModel: 'small-model', strongModel: 'big-model' };
  const prompts = ['rename this variable', 'fix the failing login test and add a regression test', 'refactor the payment module across services, keep the API stable and migrate the database schema', 'what does src/cli.mjs do?'];
  const calls = 20000;
  for (let i = 0; i < 2000; i += 1) selectTaskModel(prompts[i % prompts.length], 'big-model', routing);
  const started = process.hrtime.bigint();
  for (let i = 0; i < calls; i += 1) selectTaskModel(prompts[i % prompts.length], 'big-model', routing);
  const perCallUs = Number(process.hrtime.bigint() - started) / 1e3 / calls;
  return { calls, perCallMicroseconds: round(perCallUs, 2) };
}

const MCP_SERVER = [
  "let buffer = ''; process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { buffer += chunk; let i;",
  "  while ((i = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);",
  "    let m; try { m = JSON.parse(line); } catch { continue; } if (m.id === undefined) continue; let result = {};",
  "    if (m.method === 'initialize') result = { protocolVersion: '2024-11-05', serverInfo: { name: 'perf', version: '1' }, capabilities: { tools: {} } };",
  "    if (m.method === 'tools/list') result = { tools: Array.from({ length: 20 }, (_, n) => ({ name: 'tool_' + n, description: 'Tool ' + n, inputSchema: { type: 'object', properties: { value: { type: 'string' } } } })) };",
  "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n'); } });"
].join('\n');

async function mcpStartup(box, runs) {
  const { connectMcpServers } = await import(pathToFileURL(path.join(repoRoot, 'src', 'mcp.mjs')).href);
  const times = [];
  let tools = 0;
  for (let i = 0; i < runs; i += 1) {
    const config = { name: 'perf', command: process.execPath, args: ['-e', MCP_SERVER] };
    const started = process.hrtime.bigint();
    const { clients, failures } = await connectMcpServers({ env: box.env, skipUser: true, extraServers: [config] });
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
    if (failures.length) throw new Error('MCP probe failed: ' + JSON.stringify(failures).slice(0, 300));
    for (const client of clients.values()) {
      tools = Array.isArray(client.tools) ? client.tools.length : tools;
      client.close();
    }
  }
  return { server: 'stdio, Node.js, 20 tools', connectMs: summarize(times), toolsListed: tools };
}

export async function measure({ runs = 7 } = {}) {
  const box = await scratch();
  try {
    const result = {
      measuredAt: new Date().toISOString(),
      runtime: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length, cpuModel: (os.cpus()[0] || {}).model || null, memoryGb: round(os.totalmem() / 1024 ** 3), loadAverage: os.loadavg().map((value) => round(value, 2)) },
      runs,
      launch: [await launch(box, ['--version'], runs), await launch(box, ['--help'], runs)],
      session: await sessionCost(box, runs),
      web: await webMemory(box),
      routing: await routingOverhead(),
      mcp: await mcpStartup(box, runs)
    };
    return result;
  } finally {
    await rm(box.dir, { recursive: true, force: true });
  }
}

function printReport(result) {
  const line = (label, value) => process.stdout.write('  ' + label.padEnd(34) + value + '\n');
  const ms = (s) => (s ? s.median.toFixed(0) + ' ms median, p90 ' + s.p90.toFixed(0) : 'n/a');
  process.stdout.write('OASIS runtime performance (' + result.runtime.node + ', ' + result.runtime.platform + ' ' + result.runtime.arch + ', ' + result.runtime.cpus + ' CPUs, load ' + result.runtime.loadAverage.join(' ') + ')\n');
  for (const row of result.launch) line('oasis ' + row.args, ms(row.wallMs) + ', peak RSS ' + row.peakRssMb.median + ' MB');
  line('import agent runtime', ms(result.session.importMs));
  line('create session (default tools)', ms(result.session.createSessionMs) + ', ' + result.session.tools + ' tools, RSS ' + result.session.rssMb.median + ' MB');
  line('first request size', '~' + result.session.firstRequestTokens.total + ' tokens (system ' + result.session.firstRequestTokens.system + ', tool schemas ' + result.session.firstRequestTokens.toolSchemas + ')');
  if (result.web.skipped) line('web workspace', 'skipped: ' + result.web.skipped);
  else line('web workspace RSS', result.web.idleRssMb + ' MB idle, ' + result.web.afterServingRssMb + ' MB after serving ' + result.web.servedKb + ' KB');
  line('task routing decision', result.routing.perCallMicroseconds + ' µs per call');
  line('stdio MCP server connect', ms(result.mcp.connectMs) + ' (' + result.mcp.toolsListed + ' tools listed)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: npm run bench:perf -- [--runs 1-50] [--json FILE]\n\nMeasures CLI launch, runtime import and session creation, web workspace memory,\ntask-routing overhead and stdio MCP startup. No model or network is used.\n');
  } else {
    const result = await measure(options);
    printReport(result);
    if (options.json) await writeFile(options.json, JSON.stringify(result, null, 2) + '\n');
  }
}
