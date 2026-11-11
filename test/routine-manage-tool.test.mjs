import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { manageRoutine, SESSION_TOOL_DEFINITIONS, runSessionTool } from '../src/session-tools.mjs';
import { readJobs } from '../src/routines.mjs';

async function tempEnv(extra = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-rm-'));
  return { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_SCHEDULED_RUN: '', ...extra };
}
const session = { root: '/tmp/project-x' };

test('routine_manage is a registered session tool with the full action set', () => {
  const def = SESSION_TOOL_DEFINITIONS.find((d) => d.function.name === 'routine_manage');
  assert.ok(def);
  assert.deepEqual(def.function.parameters.properties.action.enum, ['list', 'show', 'create', 'edit', 'pause', 'resume', 'run', 'cancel', 'remove']);
});

test('routine_manage create asks every time, shows the spec, and defaults workdir to the workspace', async () => {
  const env = await tempEnv();
  const asked = [];
  const result = await manageRoutine(session, { action: 'create', schedule: 'every 2h', prompt: 'check CI and summarize', name: 'ci' }, { env, approval: async (q, always) => { asked.push([q, always]); return true; } });
  assert.equal(asked.length, 1);
  assert.equal(asked[0][1], true);
  assert.match(asked[0][0], /every 2h/);
  assert.match(asked[0][0], /check CI/);
  assert.match(asked[0][0], /project-x/);
  assert.equal(result.created.name, 'ci');
  assert.equal(result.created.workdir, '/tmp/project-x');
  assert.match(result.note, /schedule daemon/);
  const listed = await manageRoutine(session, { action: 'list' }, { env });
  assert.equal(listed.routines.length, 1);
});

test('routine_manage refuses mutations with no approver, and declined approvals change nothing', async () => {
  const env = await tempEnv();
  await assert.rejects(manageRoutine(session, { action: 'create', schedule: 'every 1h', prompt: 'x' }, { env }), /needs the user's approval/);
  const declined = await manageRoutine(session, { action: 'create', schedule: 'every 1h', prompt: 'x' }, { env, approval: async () => false });
  assert.equal(declined.approved, false);
  assert.equal((await readJobs(env)).length, 0);
});

test('routine_manage pause needs no approval, resume/remove do; scheduled runs cannot create routines', async () => {
  const env = await tempEnv();
  const yes = async () => true;
  const { created } = await manageRoutine(session, { action: 'create', schedule: 'every 1h', prompt: 'x', name: 'job' }, { env, approval: yes });
  const paused = await manageRoutine(session, { action: 'pause', id: 'job' }, { env });
  assert.equal(paused.paused.enabled, false);
  await assert.rejects(manageRoutine(session, { action: 'resume', id: 'job' }, { env }), /approval/);
  assert.equal((await manageRoutine(session, { action: 'resume', id: created.id }, { env, approval: yes })).resumed.enabled, true);
  const shown = await manageRoutine(session, { action: 'show', id: 'job' }, { env });
  assert.equal(shown.routine.prompt, 'x');
  await manageRoutine(session, { action: 'remove', id: 'job' }, { env, approval: yes });
  assert.equal((await readJobs(env)).length, 0);
  const scheduled = { ...env, OASIS_SCHEDULED_RUN: '1' };
  await assert.rejects(manageRoutine(session, { action: 'create', schedule: 'every 1h', prompt: 'x' }, { env: scheduled, approval: yes }), /scheduled run/);
});

test('routine_manage dispatches through runSessionTool', async () => {
  const env = await tempEnv();
  const out = await runSessionTool(session, 'routine_manage', { action: 'list' }, { env });
  assert.deepEqual(JSON.parse(typeof out === 'string' ? out : JSON.stringify(out)).routines ?? out.routines, []);
});
