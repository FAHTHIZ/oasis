import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
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
