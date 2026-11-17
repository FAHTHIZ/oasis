// Prompt-surface snapshots: the system prompt and the tool list OASIS sends on
// the first request, for a few fixed configurations. Providers cache the
// prompt prefix, and the model's behaviour follows these words, so a change to
// either must be deliberate. When a change is intended, regenerate with
//
//   OASIS_UPDATE_PROMPT_SNAPSHOTS=1 node --test test/prompt-surface.test.mjs
//
// and review the diff of test/fixtures/prompt-surface/ like any other change.
// Idea adapted from Hermes Agent's prompt-caching rule (MIT).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures', 'prompt-surface');
const UPDATE = /^(?:1|true|yes)$/i.test(String(process.env.OASIS_UPDATE_PROMPT_SNAPSHOTS || ''));
const CANONICAL_ROOT = '/workspace';

const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-prompt-surface-'));
process.env.OASIS_CONFIG_DIR = path.join(base, 'config');
process.env.OASIS_NO_UPDATE_CHECK = '1';
process.env.OASIS_TELEMETRY = '0';
const { createSession, runAgentTurn, closeSession } = await import('../src/agent.mjs');
const { evalAgentEnvironment } = await import('../src/eval.mjs');

test.after(() => rm(base, { recursive: true, force: true }));

// Host facts are real prompt content but differ between machines; replace
// them with fixed stand-ins so the snapshot measures OASIS only.
function hostIndependent(text, root) {
  const escaped = JSON.stringify(root).slice(1, -1);
  return String(text)
    .split(escaped).join(CANONICAL_ROOT)
    .split(root).join(CANONICAL_ROOT)
    .replace(/Platform: [a-z0-9]+ [^\s"\\]+ \([a-z0-9_]+\), Node v[0-9.]+/g, 'Platform: <platform>, Node <version>')
    .replace(/Today's date: \d{4}-\d{2}-\d{2}/g, "Today's date: <date>")
    .replace(/\.oasis(?:\/|\\{1,2})scratch(?:\/|\\{1,2})[0-9a-f]{8}(?:\/|\\{1,2})/g, '.oasis/scratch/<id>/')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
}

const reply = (body, message) => new Response(JSON.stringify({ id: 'snap', object: 'chat.completion', model: body.model, choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });

async function workspace(name, { git = false, instructions = '' } = {}) {
  const root = path.join(base, 'ws-' + name);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'index.js'), 'export const answer = 42;\n');
  if (instructions) await writeFile(path.join(root, 'OASIS.md'), instructions);
  if (git) {
    const env = { ...process.env, GIT_AUTHOR_NAME: 'snap', GIT_AUTHOR_EMAIL: 'snap@example.invalid', GIT_COMMITTER_NAME: 'snap', GIT_COMMITTER_EMAIL: 'snap@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
    for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'snapshot']]) {
      const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
      assert.equal(result.status, 0, 'git ' + args.join(' ') + ': ' + result.stderr);
    }
  }
  return root;
}

// Runs one turn with a scripted provider and returns the request bodies.
async function capture(name, { sessionOptions = {}, config = {}, git = false, instructions = '', script = [] } = {}) {
  const root = await workspace(name, { git, instructions });
  const env = { ...evalAgentEnvironment(process.env), HOME: path.join(base, 'home-' + name), USERPROFILE: path.join(base, 'home-' + name), OASIS_CONFIG_DIR: process.env.OASIS_CONFIG_DIR,
    // Optional host tools (PowerShell on Windows, an installed ast-grep) add
    // tools and prompt lines; they have their own tests.
    OASIS_POWERSHELL: '0', OASIS_AST_GREP: '0' };
  const bodies = [];
  let step = 0;
  const fetchImpl = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body || '{}'));
    bodies.push(body);
    // The scripted calls belong to the main conversation (its first message
    // is the user's prompt); subagent conversations just answer.
    const main = body.messages.some((m) => m.role === 'user' && m.content === 'snapshot prompt');
    const next = main ? script[step++] : null;
    return reply(body, next ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + step, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }] } : { role: 'assistant', content: 'done' });
  };
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'https://prompt-surface.invalid/v1', model: 'snapshot-model', apiKey: 'snapshot-key', maxSteps: 4, ...config }, env, ...sessionOptions });
  // Subagents use the global fetch, so the scripted provider replaces it for
  // the turn; nothing in this test may reach the network.
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await runAgentTurn(session, 'snapshot prompt', { autoApprove: true, env, maxSteps: 4, fetchImpl });
  } finally {
    globalThis.fetch = realFetch;
    closeSession(session);
  }
  return { bodies, root };
}

function surface(body, root) {
  const system = body.messages.filter((m) => m.role === 'system').map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n\n----- next system message -----\n\n');
  const tools = (body.tools || []).map((t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters }));
  return {
    system: hostIndependent(system, root),
    tools: JSON.parse(hostIndependent(JSON.stringify(tools), root))
  };
}

async function compare(name, value) {
  const file = path.join(FIXTURES, name + '.json');
  const text = JSON.stringify(value, null, 2) + '\n';
  if (UPDATE || !existsSync(file)) {
    if (!UPDATE) assert.fail('Missing snapshot ' + path.relative(path.join(here, '..'), file) + '. Run OASIS_UPDATE_PROMPT_SNAPSHOTS=1 node --test test/prompt-surface.test.mjs and commit it.');
    await mkdir(FIXTURES, { recursive: true });
    await writeFile(file, text);
    return;
  }
  const expected = JSON.parse(await readFile(file, 'utf8'));
  const hint = 'Prompt surface "' + name + '" changed. If intended, run OASIS_UPDATE_PROMPT_SNAPSHOTS=1 node --test test/prompt-surface.test.mjs and review the fixture diff.';
  assert.deepEqual(value.tools.map((t) => t.name), expected.tools.map((t) => t.name), hint + ' (tool list)');
  assert.deepEqual(value.tools, expected.tools, hint + ' (tool schemas)');
  assert.equal(value.system, expected.system, hint + ' (system prompt)');
}

test('default session: system prompt and tools are unchanged', async () => {
  const { bodies, root } = await capture('default');
  await compare('default', surface(bodies[0], root));
});

test('git repository with project instructions: system prompt and tools are unchanged', async () => {
  const { bodies, root } = await capture('project', { git: true, instructions: '# Project rules\n\nUse tabs for indentation.\n' });
  await compare('project-instructions', surface(bodies[0], root));
});

test('plan mode: system prompt and tools are unchanged', async () => {
  const { bodies, root } = await capture('plan', { sessionOptions: { permissionMode: 'plan' } });
  await compare('plan-mode', surface(bodies[0], root));
});

test('small context window: system prompt and tools are unchanged', async () => {
  const { bodies, root } = await capture('small', { config: { contextWindow: 16000 } });
  await compare('small-context', surface(bodies[0], root));
});

test('explore subagent: system prompt and tools are unchanged', async () => {
  const { bodies, root } = await capture('subagent', { script: [{ name: 'task', args: { description: 'Look around', prompt: 'List the files and report.', subagent_type: 'explore' } }] });
  const child = bodies.find((body) => !body.messages.some((m) => m.role === 'user' && m.content === 'snapshot prompt'));
  assert.ok(child, 'the explore subagent sent a request; main conversation ended with: ' + JSON.stringify(bodies.at(-1).messages.at(-1)).slice(0, 600));
  await compare('explore-subagent', surface(child, root));
});

test('the system prompt is byte-stable across turns of one conversation', async () => {
  const { bodies } = await capture('stable', { script: [{ name: 'read_file', args: { path: 'index.js' } }] });
  assert.ok(bodies.length >= 2, 'the scripted tool call produced a second request');
  const systems = bodies.map((body) => JSON.stringify(body.messages.filter((m) => m.role === 'system')));
  assert.equal(new Set(systems).size, 1, 'the system messages changed between requests of one turn');
  const tools = bodies.map((body) => JSON.stringify(body.tools || []));
  assert.equal(new Set(tools).size, 1, 'the tool list changed between requests although no tool was loaded');
});
