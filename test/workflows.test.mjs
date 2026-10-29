import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { runBuiltinCommand, BUILTIN_COMMANDS } from '../src/slash.mjs';
import { loadCustomCommands } from '../src/commands.mjs';
import { runWorkflow, parseWorkflowScript, loadWorkflows, saveWorkflow } from '../src/workflows.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
const lastUser = (payload) => { const users = payload.messages.filter((m) => m.role === 'user'); const m = users[users.length - 1]; return typeof m.content === 'string' ? m.content : JSON.stringify(m.content); };

const SCRIPT = `export const meta = { name: 'audit-demo', description: 'Audit files', phases: ['Find', 'Audit'] }
phase('Find')
const found = await agent('LIST the files', { label: 'find', schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } } })
phase('Audit')
const audits = await pipeline(found.files, (file) => agent('AUDIT ' + file, { label: file }))
log('audited', audits.length)
return audits.filter(Boolean)`;

test('OASIS can load without QuickJS and gives a helpful message when a workflow runs', () => {
  const loader = fileURLToPath(new URL('./helpers/block-quickjs-loader.mjs', import.meta.url));
  const workflowsUrl = new URL('../src/workflows.mjs', import.meta.url).href;
  const childScript = [
    'const { runWorkflow } = await import(' + JSON.stringify(workflowsUrl) + ');',
    "const result = await runWorkflow({ source: 'return 42', runAgent: async () => '' });",
    "console.log(result.error || '');",
    "if (result.status !== 'failed') process.exitCode = 2;"
  ].join('\n');
  const output = execFileSync(process.execPath, [
    '--no-warnings', '--experimental-loader', loader, '--input-type=module', '-e', childScript
  ], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    timeout: 5000
  });
  assert.match(output, /Workflows need quickjs-emscripten\. Run npm install\./);
});

test('workflow sandbox pumps pending jobs for plain workflow results', async () => {
  const result = await runWorkflow({ source: 'return 42', runAgent: async () => '' });
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 42);
});

test('runWorkflow: schema, pipeline nulls failures, resume reuses completed agents', async () => {
  let calls = 0;
  const first = await runWorkflow({ source: SCRIPT, runAgent: async ({ prompt }) => { calls++; if (prompt.startsWith('LIST')) return '{"files":["a","b","c"]}'; if (prompt.endsWith(' b')) throw new Error('boom'); return 'ok ' + prompt; } });
  assert.equal(first.status, 'completed');
  assert.deepEqual(first.result, ['ok AUDIT a', 'ok AUDIT c']);
  assert.equal(calls, 4);
  assert.deepEqual(first.phases.map((p) => p.title), ['Find', 'Audit']);
  const second = await runWorkflow({ source: SCRIPT, cache: { calls: first.calls }, runAgent: async ({ prompt }) => { calls++; return 'again ' + prompt; } });
  assert.equal(calls, 5, 'only the failed agent reruns');
  assert.deepEqual(second.result, ['ok AUDIT a', 'again AUDIT b', 'ok AUDIT c']);
});

test('workflow scripts are sandboxed: no import, no Date.now', async () => {
  assert.throws(() => parseWorkflowScript('const fs = await import("node:fs")'), /import/);
  const bad = await runWorkflow({ source: 'return Date.now()', runAgent: async () => '' });
  assert.equal(bad.status, 'failed');
  assert.match(parseWorkflowScript(SCRIPT).meta.name, /audit-demo/);
});


test('workflow runtime isolates Node host APIs and blocks host-constructor escape', async () => {
  const result = await runWorkflow({
    source: "return { process: typeof process, require: typeof require, globalProcess: typeof globalThis.process, escape: (() => { try { return agent.constructor.constructor('return process')(); } catch { return 'blocked'; } })(), random: (() => { try { Math.random(); return 'allowed'; } catch { return 'blocked'; } })(), clock: (() => { try { Date.now(); return 'allowed'; } catch { return 'blocked'; } })() }",
    runAgent: async () => ''
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.result.process, 'undefined');
  assert.equal(result.result.require, 'undefined');
  assert.equal(result.result.globalProcess, 'undefined');
  assert.equal(result.result.escape, 'blocked');
  assert.equal(result.result.random, 'blocked');
  assert.equal(result.result.clock, 'blocked');
});

test('workflow runtime interrupts CPU-bound JavaScript', async () => {
  const started = Date.now();
  const result = await runWorkflow({ source: 'while (true) {}', runAgent: async () => '' });
  assert.equal(result.status, 'failed');
  assert.ok(Date.now() - started < 6000, 'untrusted script should not monopolize the process indefinitely');
  assert.match(result.error, /interrupt|execut|failed/i);
});

test('workflow metadata parser refuses executable expressions', () => {
  globalThis.__OASIS_METADATA_EXECUTED__ = false;
  try {
    const parsed = parseWorkflowScript("export const meta = { name: (globalThis.__OASIS_METADATA_EXECUTED__ = true, 'pwned') }\nreturn 1");
    assert.equal(parsed.meta.name, undefined);
    assert.equal(parsed.literalMeta, false);
    assert.equal(globalThis.__OASIS_METADATA_EXECUTED__, false);
  } finally {
    delete globalThis.__OASIS_METADATA_EXECUTED__;
  }
});

test('loadWorkflows precedence, builtin deep-research, save refuses symlinks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-wf-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-wf-home-'));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, '.oasis'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
  const builtin = await loadWorkflows(root, { env, plugins: [] });
  assert.ok(builtin.has('deep-research'));
  assert.equal(builtin.get('deep-research').scope, 'builtin');
  await mkdir(path.join(root, '.claude', 'workflows'), { recursive: true });
  await writeFile(path.join(root, '.claude', 'workflows', 'deep-research.js'), "export const meta = { name: 'deep-research', description: 'mine' }\nreturn 1");
  const mine = await loadWorkflows(root, { env, plugins: [] });
  assert.equal(mine.get('deep-research').scope, 'project');
  const saved = await saveWorkflow(SCRIPT, { root, env });
  assert.match(await readFile(saved, 'utf8'), /audit-demo/);
  const evil = await mkdtemp(path.join(os.tmpdir(), 'oasis-wf-evil-'));
  const root2 = await mkdtemp(path.join(os.tmpdir(), 'oasis-wf2-'));
  await symlink(evil, path.join(root2, '.claude'));
  await assert.rejects(saveWorkflow(SCRIPT, { root: root2, env }), /symlink/);
  const commands = await loadCustomCommands(root, { env });
  assert.ok(commands.get('audit-demo').workflow);
  assert.match(commands.get('audit-demo').body, /workflow tool/);
});

test('workflow tool runs subagents from the main session and /workflows reports it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-wf-tool-'));
  const env = { ...process.env, HOME: root, OASIS_CONFIG_DIR: path.join(root, '.oasis-config') };
  let mainTurns = 0;
  const { config } = await scriptedModel(t, [(payload) => {
    const user = lastUser(payload);
    const last = payload.messages[payload.messages.length - 1];
    if (user.startsWith('LIST')) return { content: '{"files":["x","y"]}' };
    if (user.startsWith('AUDIT')) return { content: 'clean ' + user.slice(6) };
    if (last.role === 'tool') return { content: 'Workflow finished.' };
    mainTurns++;
    assert.ok(payload.tools.some((tool) => tool.function.name === 'workflow'));
    assert.match(user, /Ultracode/);
    return toolCall('w1', 'workflow', { script: SCRIPT });
  }]);
  config.maxSteps = 30;
  const session = await createSession({ root, config, settings, env });
  t.after(() => closeSession(session));
  const result = await runAgentTurn(session, 'ultracode: audit everything', { env });
  assert.equal(result.text, 'Workflow finished.');
  assert.equal(mainTurns, 1);
  const toolMessage = session.messages.find((m) => m.role === 'tool');
  const payload = JSON.parse(toolMessage.content);
  assert.equal(payload.status, 'completed');
  assert.deepEqual(payload.result, ['clean x', 'clean y']);
  const listing = await runBuiltinCommand('workflows', '', { root, session, env });
  assert.match(listing.output, /audit-demo/);
  assert.match(listing.output, /3\/3 agents done/);
  const detail = await runBuiltinCommand('workflows', payload.run_id, { root, session, env });
  assert.match(detail.output, /Audit — 2\/2/);
  const save = await runBuiltinCommand('workflows', 'save ' + payload.run_id, { root, session, env });
  assert.match(save.output, /\/audit-demo/);
});

test('built-in audit workflow merges duplicate findings and preserves partial reviewer failures', async () => {
  const workflows = await loadWorkflows(process.cwd());
  const audit = workflows.get('audit');
  assert.ok(audit, 'audit workflow is discoverable as a built-in workflow');
  const source = await readFile(audit.file, 'utf8');
  const calls = [];
  const finding = {
    title: 'Unsafe path validation',
    severity: 'high',
    file: 'src/a.ts',
    line: 7,
    evidence: 'The path is joined without checking the resolved workspace boundary.',
    fix: 'Resolve the path and reject traversal before access.',
    confidence: 0.82
  };
  const result = await runWorkflow({
    source,
    args: 'src/',
    runAgent: async ({ label, prompt }) => {
      calls.push(label);
      if (label === 'dependency reviewer') throw new Error('simulated dependency worker failure');
      if (label === 'security reviewer') return JSON.stringify({ findings: [finding] });
      if (label === 'performance reviewer') return JSON.stringify({ findings: [{ ...finding, evidence: 'A second reviewer observed the same unsafe path join.', confidence: 0.75 }] });
      if (label === 'test coverage reviewer') return JSON.stringify({ findings: [] });
      if (label.startsWith('verify finding')) return JSON.stringify({ verdict: 'verified', reason: 'The cited path join is confirmed by source inspection.' });
      throw new Error('unexpected worker: ' + label);
    }
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.result.status, 'partial');
  assert.deepEqual(result.result.reviewersFailed, ['dependency']);
  assert.equal(result.result.reviewersSucceeded, 3);
  assert.equal(result.result.summary.total, 1, 'overlapping reviewer findings should be merged');
  assert.equal(result.result.verifiedFindings.length, 1);
  assert.equal(result.result.verifiedFindings[0].verified, true);
  assert.deepEqual(result.result.verifiedFindings[0].provenance.sort(), ['performance', 'security']);
  assert.equal(calls.filter((label) => label.startsWith('verify finding')).length, 1);
});

test('/audit is listed and delegates to the built-in workflow instead of a single review', async () => {
  assert.ok(BUILTIN_COMMANDS.audit);
  const root = process.cwd();
  const state = { root, env: process.env, session: { root, messages: [], settings: {} } };
  const handled = await runBuiltinCommand('audit', 'src/security', state);
  assert.match(handled.prompt, /workflow named "audit"/);
  assert.match(handled.prompt, /security, performance, test-coverage, and dependency reviewers/);
  assert.match(handled.prompt, /verified and unverified findings/);
  assert.match(handled.prompt, /src\/security/);
});

