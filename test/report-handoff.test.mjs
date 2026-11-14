import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, symlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { handOffReport, reportHandoffThreshold, reportPreview } from '../src/report-handoff.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

// A 60,000-character report with a marker in the middle. The parent's 24,000-character
// tool-result cap used to keep head and tail only, so the marker never reached the parent.
const BIG = Array.from({ length: 1200 }, (_, i) => 'finding ' + i + ': ' + 'x'.repeat(38)).join('\n').replace('finding 600:', 'MIDDLE-MARKER finding 600:');

test('handOffReport writes long reports to scratch and previews them', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-handoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await handOffReport({ root, scratchDir: '.oasis/scratch/k1', agentId: 'agent_1', text: 'short' }), null);
  const out = await handOffReport({ root, scratchDir: '.oasis/scratch/k1', agentId: 'agent_1', run: 2, text: BIG });
  assert.equal(out.file, '.oasis/scratch/k1/agents/agent_1-run2.md');
  assert.equal((await readFile(path.join(root, out.file), 'utf8')).trimEnd(), BIG);
  assert.ok(out.preview.length < 9000, 'preview is small: ' + out.preview.length);
  assert.match(out.preview, /agents\/agent_1-run2\.md/);
  assert.ok(existsSync(path.join(root, '.oasis/scratch/.gitignore')), 'scratch stays git-ignored');
  assert.equal(await handOffReport({ root, scratchDir: '../outside', agentId: 'a', text: BIG }), null, 'only the scratch folder');
  assert.equal(reportHandoffThreshold({ OASIS_SUBAGENT_HANDOFF_CHARS: 'off' }), Infinity);
  assert.equal(reportHandoffThreshold({ OASIS_SUBAGENT_HANDOFF_CHARS: '5000' }), 5000);
  assert.match(reportPreview(BIG, 'f.md'), /not shown here/);
});

test('handOffReport refuses a symlinked scratch folder', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-handoff-link-'));
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'oasis-handoff-else-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(elsewhere, { recursive: true, force: true })]));
  await mkdir(path.join(root, '.oasis'), { recursive: true });
  await symlink(elsewhere, path.join(root, '.oasis', 'scratch'));
  assert.equal(await handOffReport({ root, scratchDir: '.oasis/scratch/k', agentId: 'a', text: BIG }), null);
});

test('a long subagent report reaches the parent as a file it can read in full', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-handoff-e2e-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let toolResult = null;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const isChild = payload.messages[0].content.includes('SUBAGENT MODE');
    const last = payload.messages.at(-1);
    let message;
    if (isChild) message = { content: BIG };
    else if (last.role === 'user') message = { content: null, tool_calls: [call('t1', 'task', { description: 'survey', prompt: 'survey', subagent_type: 'explore' })] };
    else { toolResult = toolResult || last.content; message = { content: 'done' }; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 6 };
  const session = await createSession({ root, config, settings });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'start', { autoApprove: true });
  assert.ok(toolResult, 'parent saw the task result');
  const parsed = JSON.parse(toolResult);
  assert.ok(parsed.report_file, 'handoff file named: ' + toolResult.slice(0, 300));
  assert.ok(toolResult.length < 12000, 'parent context cost is bounded: ' + toolResult.length);
  const full = await readFile(path.join(root, parsed.report_file), 'utf8');
  assert.match(full, /MIDDLE-MARKER/, 'the middle of the report is not lost');
  assert.equal(session.agentTasks.agents.get('agent_1').report.length, BIG.length, 'agent_status keeps the full text');
});
