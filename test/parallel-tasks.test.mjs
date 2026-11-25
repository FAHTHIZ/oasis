import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { completedDetail } from '../src/agent-subagents.mjs';
import { friendlyBudget } from '../app/core/subagents.mjs';
import { BUILTIN_AGENTS, taskToolDefinition } from '../src/subagents.mjs';

test('one task call with parallel_tasks runs every agent at the same time', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-parallel-tasks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let inFlight = 0;
  let peak = 0;
  const { config } = await scriptedModel(t, [async (payload) => {
    if (payload.messages[0].content.includes('SUBAGENT MODE')) {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 300));
      inFlight--;
      const ask = String(payload.messages.find((m) => m.role === 'user').content);
      return { content: 'report for ' + (/alpha/.test(ask) ? 'alpha' : /beta/.test(ask) ? 'beta' : 'gamma') };
    }
    if (payload.messages.some((m) => m.role === 'tool')) return { content: 'all done' };
    return toolCall('t1', 'task', { description: 'three jobs', prompt: 'do all three', parallel_tasks: [{ description: 'alpha', prompt: 'do alpha' }, { description: 'beta', prompt: 'do beta' }, { description: 'gamma', prompt: 'do gamma' }] });
  }]);
  const session = await createSession({ root, config, env: { ...process.env, HOME: root, OASIS_CONFIG_DIR: path.join(root, '.cfg') } });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'three things at once', { autoApprove: true });
  const tool = session.messages.find((m) => m.role === 'tool' && m.name === 'task');
  const result = JSON.parse(tool.content);
  assert.equal(result.ran_together, 3);
  assert.deepEqual(result.agents.map((a) => a.report), ['report for alpha', 'report for beta', 'report for gamma']);
  assert.ok(peak >= 2, 'agents overlapped (peak ' + peak + ')');
});

test('the task tool tells the model how to run agents together and warns about worktrees', () => {
  const fn = taskToolDefinition(BUILTIN_AGENTS).function;
  assert.match(fn.description, /parallel_tasks/);
  assert.equal(fn.parameters.properties.parallel_tasks.type, 'array');
  assert.match(fn.parameters.properties.isolation.description, /NOT in the user's folder/);
  assert.deepEqual(fn.parameters.required, ['description', 'prompt']);
});

test('a finished agent line shows its report and an unmerged branch', () => {
  assert.equal(completedDetail('## Found\n\n* `total` adds tax twice', null), 'Found total adds tax twice');
  assert.match(completedDetail('Wrote README.md', { changed: true, branch: 'oasis/readme-1' }), /^Changes on branch oasis\/readme-1 \(not merged yet\)\. Wrote README\.md$/);
  assert.match(completedDetail('', null, { toolCalls: 3 }), /no report \(3 steps\)/);
  assert.ok(completedDetail('x'.repeat(900), null).length <= 500);
});

test('budget lines read in plain words', () => {
  assert.equal(friendlyBudget('tokens 8,218, requests 2, steps 2'), '8.2k tokens · 2 requests · 2 steps');
  assert.equal(friendlyBudget('budget tokens 31,209/50,000, steps 1'), '31k of 50k tokens · 1 step');
  assert.equal(friendlyBudget(''), '');
});

test('parallel_tasks is the whole group; odd shapes from weak models are repaired', async () => {
  const { promoteParallelTask } = await import('../src/agent.mjs');
  const schema = taskToolDefinition(BUILTIN_AGENTS).function.parameters;
  const two = [{ description: 'a', prompt: 'do a' }, { description: 'b', prompt: 'do b', subagent_type: 'explore' }];
  assert.deepEqual(promoteParallelTask(schema, { parallel_tasks: two }), { description: '2 agents', prompt: 'Run these agents together.', parallel_tasks: two });
  assert.deepEqual(promoteParallelTask(schema, { description: 'Multitask', prompt: 'everything', parallel_tasks: two }).parallel_tasks, two, 'an umbrella prompt is only a label');
  const fromString = promoteParallelTask(schema, { tasks: JSON.stringify([{ task: 'do x' }]) });
  assert.equal(fromString.prompt, 'do x');
  assert.equal('parallel_tasks' in fromString, false, 'one entry is a plain task');
  const untouched = { description: 'd', prompt: 'p' };
  assert.deepEqual(promoteParallelTask(schema, untouched), untouched);
});

test('a subagent\'s computed numbers count as evidence for the parent', async () => {
  const { liftChildEvidence } = await import('../src/agent-subagents.mjs');
  const { analysisContract } = await import('../src/verification-contracts.mjs');
  const parent = {};
  const childEvents = [
    { seq: 4, at: 1, epoch: 0, kind: 'execution', tool: 'run_command', numbers: ['1110'], digest: 'x' },
    { seq: 5, at: 1, epoch: 0, kind: 'check', tool: 'run_command', ok: true, digest: 'y' },
    { seq: 6, at: 1, epoch: 0, kind: 'edit', path: 'a.js', digest: 'z' }
  ];
  assert.equal(analysisContract('Gizmo sold 1,110 units.', parent.evidenceLedger ? parent.evidenceLedger.events : []).length, 1);
  assert.equal(liftChildEvidence(parent, childEvents, 'agent_1'), 1, 'only outputs are lifted, not checks or edits');
  assert.equal(parent.evidenceLedger.events[0].via, 'agent_1');
  assert.equal(parent.evidenceLedger.epoch, 0);
  assert.deepEqual(analysisContract('Gizmo sold 1,110 units.', parent.evidenceLedger.events), []);
});
