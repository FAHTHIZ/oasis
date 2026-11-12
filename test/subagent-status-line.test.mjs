import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { renderSubagentStatusLines, subagentStatusLinePayload } from '../src/status-line.mjs';
import { loadSettings, setWorkspaceTrust } from '../src/settings.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { registerAgent } from '../src/agent-tasks.mjs';

// Reads the payload, saves it, and rewrites agent_1, hides agent_2, leaves agent_3 alone.
function script(dir) {
  const file = path.join(dir, 'rows.mjs');
  return writeFile(file, [
    "import { writeFileSync } from 'node:fs';",
    "let d = '';",
    "process.stdin.on('data', (c) => d += c).on('end', () => {",
    "  const j = JSON.parse(d);",
    "  writeFileSync(process.env.ROWS_OUT, d);",
    "  for (const t of j.tasks) {",
    "    if (t.id === 'agent_1') console.log(JSON.stringify({ id: t.id, content: '\\x1b[36m' + t.agentType + ' ' + t.status + ' ' + t.tokenCount + 'tok @' + j.columns + '\\x1b[0m' }));",
    "    if (t.id === 'agent_2') console.log(JSON.stringify({ id: t.id, content: '' }));",
    "  }",
    "  console.log('not json');",
    "  console.log(JSON.stringify({ id: 'agent_99', content: 'unknown' }));",
    "});"
  ].join('\n')).then(() => JSON.stringify(process.execPath) + ' ' + JSON.stringify(file));
}

test('subagentStatusLine gets every row as JSON and replaces or hides the rows it names', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-substatus-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = await script(root);
  const out = path.join(root, 'payload.json');
  const env = { ...process.env, ROWS_OUT: out };
  const session = { sessionId: 's1', root, messages: [], permissions: { mode: 'default' }, settings: { subagentStatusLine: { type: 'command', command } } };
  const child = (model) => ({ root, config: { model, reasoningEffort: 'high' }, messages: [{ role: 'system', content: 'x'.repeat(400) }] });
  registerAgent(session, { type: 'code-reviewer', description: 'Review the diff', background: true, child: child('gpt-x') });
  registerAgent(session, { type: 'explore', description: 'Find callers', child: child('gpt-y') });
  const third = registerAgent(session, { type: 'general-purpose', description: 'Write docs', child: child('') });
  third.status = 'completed';

  const result = await runBuiltinCommand('tasks', '', { root, session, env, width: 82 });
  assert.match(result.output, /\n {2}code-reviewer running \d+tok @80\n/);
  assert.ok(!result.output.includes('\x1b['), 'colours dropped without a terminal');
  assert.ok(!result.output.includes('Find callers'), 'empty content hides the row');
  assert.match(result.output, /agent_3 +completed +fg general-purpose: Write docs/, 'unnamed rows keep the default');
  assert.ok(!result.output.includes('unknown'));

  const payload = JSON.parse(await (await import('node:fs/promises')).readFile(out, 'utf8'));
  assert.equal(payload.hook_event_name, 'SubagentStatus');
  assert.equal(payload.session_id, 's1');
  assert.equal(payload.columns, 80);
  const [a, , c] = payload.tasks;
  assert.equal(a.id, 'agent_1');
  assert.equal(a.type, 'local_agent');
  assert.equal(a.agentType, 'code-reviewer');
  assert.equal(a.description, 'Review the diff');
  assert.equal(a.label, 'Review the diff');
  assert.equal(a.model, 'gpt-x');
  assert.equal(a.effort, 'high');
  assert.ok(a.contextWindowSize > 0);
  assert.ok(a.tokenCount > 0);
  assert.deepEqual(a.tokenSamples, [a.tokenCount]);
  assert.equal(a.cwd, root);
  assert.ok(Number.isFinite(a.startTime));
  assert.equal(c.status, 'completed');
  assert.equal(c.model, undefined, 'model omitted until known');
  assert.equal(c.contextWindowSize, undefined);

  // Colour stays on a terminal; samples accumulate per refresh, capped at 16.
  const records = [...session.agentTasks.agents.values()];
  let rows;
  for (let i = 0; i < 20; i++) rows = await renderSubagentStatusLines(session.settings.subagentStatusLine, subagentStatusLinePayload({ root, session, records, env }), { root, env, keepColor: true });
  assert.match(rows.get('agent_1'), /^\x1b\[36mcode-reviewer/);
  assert.equal(rows.get('agent_2'), '');
  assert.equal(rows.has('agent_3'), false);
  assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(out, 'utf8')).tasks[0].tokenSamples.length, 16);
  // A failing command leaves every default row.
  assert.equal((await renderSubagentStatusLines({ type: 'command', command: 'exit 2' }, subagentStatusLinePayload({ root, session, records }), { root })).size, 0);
});

test('subagentStatusLine follows the statusLine trust and hook gates', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-substatus-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-substatus-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const env = { ...process.env, OASIS_CONFIG_DIR: home, OASIS_IGNORE_CLAUDE_SETTINGS: '1' };
  await mkdir(path.join(root, '.oasis'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'settings.json'), JSON.stringify({ subagentStatusLine: { type: 'command', command: 'echo rows' } }));
  let settings = await loadSettings(root, { env });
  assert.equal(settings.subagentStatusLine, null);
  assert.equal(settings.ignoredUntrusted.length, 1);
  await setWorkspaceTrust(root, true, env);
  settings = await loadSettings(root, { env });
  assert.deepEqual(settings.subagentStatusLine, { type: 'command', command: 'echo rows' });
  await writeFile(path.join(root, '.oasis', 'settings.json'), JSON.stringify({ disableAllHooks: true, subagentStatusLine: { type: 'command', command: 'echo rows' } }));
  settings = await loadSettings(root, { env });
  assert.equal(settings.subagentStatusLine, null);
  // No setting: /tasks rows are unchanged.
  const session = { root, messages: [], settings: {} };
  registerAgent(session, { type: 'explore', description: 'Look around', child: { root, config: {} } });
  assert.match((await runBuiltinCommand('tasks', '', { root, session, env })).output, /agent_1 +running +fg explore: Look around/);
});
