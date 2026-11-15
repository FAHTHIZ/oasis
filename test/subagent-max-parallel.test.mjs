import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { maxParallelTasksFrom } from '../src/tool-batch-scheduler.mjs';
import { MAX_PARALLEL_SUBAGENTS } from '../src/subagents.mjs';

test('the parallel subagent cap defaults to the maximum and can only be lowered', () => {
  assert.equal(maxParallelTasksFrom({}, {}, MAX_PARALLEL_SUBAGENTS), MAX_PARALLEL_SUBAGENTS);
  assert.equal(maxParallelTasksFrom({ subagentMaxParallel: 2 }, {}, 6), 2);
  assert.equal(maxParallelTasksFrom({ subagentMaxParallel: 2 }, { OASIS_SUBAGENT_MAX_PARALLEL: '3' }, 6), 3);
  assert.equal(maxParallelTasksFrom({}, { OASIS_SUBAGENT_MAX_PARALLEL: '40' }, 6), 6);
  for (const bad of ['0', '-1', '1.5', 'x']) assert.equal(maxParallelTasksFrom({}, { OASIS_SUBAGENT_MAX_PARALLEL: bad }, 6), 6, bad);
  assert.equal(maxParallelTasksFrom({}, { OASIS_SUBAGENT_MAX_PARALLEL: '' }, 6), 6);
});

// The main agent asks for five subagents in one reply. Each child's model
// request is held for a moment so overlapping children are visible.
async function run(t, { env: extraEnv = {}, settings = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-max-parallel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // User-level settings: an untrusted project's settings cannot change this.
  const configDir = path.join(root, '.config-oasis');
  await mkdir(configDir, { recursive: true });
  if (settings) await writeFile(path.join(configDir, 'settings.json'), JSON.stringify(settings));
  let active = 0;
  let peak = 0;
  let children = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    const child = /SUBAGENT MODE/.test(String(payload.messages[0].content));
    let message;
    if (child) {
      children++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 150));
      active--;
      message = { role: 'assistant', content: 'child report' };
    } else if (payload.messages.some((m) => m.role === 'tool')) {
      message = { role: 'assistant', content: 'done' };
    } else {
      message = { role: 'assistant', content: null, tool_calls: Array.from({ length: 5 }, (_, i) => ({ id: 'c' + i, type: 'function', function: { name: 'task', arguments: JSON.stringify({ description: 'look ' + i, prompt: 'Report the number ' + i + '.', subagent_type: 'explore' }) } })) };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...process.env, OASIS_SUBAGENT_MAX_PARALLEL: '', OASIS_SUBAGENT_EFFORT: '', CLAUDE_CODE_SUBAGENT_EFFORT: '', OASIS_CONFIG_DIR: configDir, ...extraEnv };
  const session = await createSession({ root, env, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 } });
  await runAgentTurn(session, 'go', { autoApprove: true, env });
  return { peak, children, session };
}

test('OASIS_SUBAGENT_MAX_PARALLEL=2 runs at most two subagents at once and still runs all of them', async (t) => {
  const { peak, children } = await run(t, { env: { OASIS_SUBAGENT_MAX_PARALLEL: '2' } });
  assert.equal(children, 5);
  assert.equal(peak, 2);
});

test('without a cap the five subagents overlap', async (t) => {
  const { peak, children } = await run(t);
  assert.equal(children, 5);
  assert.ok(peak > 2, 'expected more than two overlapping children, saw ' + peak);
});

test('the subagentMaxParallel user setting reaches the session', async (t) => {
  const { peak, session } = await run(t, { settings: { subagentMaxParallel: 1 } });
  assert.equal(session.subagentMaxParallel, 1);
  assert.equal(peak, 1);
});
