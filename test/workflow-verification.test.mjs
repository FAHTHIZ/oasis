import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { workflowReportIssues } from '../src/agent-subagents.mjs';
import { clearPageStore, rememberPage } from '../src/page-store.mjs';
import { checkReport } from '../src/verification-contracts.mjs';
import { runWorkflow } from '../src/workflows.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
const lastUser = (payload) => { const users = payload.messages.filter((m) => m.role === 'user'); const m = users[users.length - 1]; return typeof m.content === 'string' ? m.content : JSON.stringify(m.content); };
const rejected = (reason) => Object.assign(new Error("OASIS rejected this agent's report: " + reason), { verification: true });

test('a rejected workflow agent is retried once with the reasons, then fails', async () => {
  const prompts = [];
  let calls = 0;
  const once = await runWorkflow({
    source: "return await agent('RESEARCH x', { label: 'r' })",
    runAgent: async ({ prompt }) => { prompts.push(prompt); calls += 1; if (calls === 1) throw rejected('it cites https://a.com/x, which this agent never fetched'); return 'fixed report'; }
  });
  assert.equal(once.status, 'completed');
  assert.equal(once.result, 'fixed report');
  assert.match(prompts[1], /OASIS rejected your previous report: it cites https:\/\/a\.com\/x, which this agent never fetched\. Fetch every page you cite/);

  const twice = await runWorkflow({
    source: "const out = await pipeline(['a'], (item) => agent('RESEARCH ' + item)); return out",
    runAgent: async () => { throw rejected('misquote'); }
  });
  assert.deepEqual(twice.result, [null], 'a report rejected twice is a failed agent, so pipeline() drops it');
  assert.equal(twice.agents[0].status, 'failed');
  assert.match(twice.agents[0].error, /rejected this agent's report: misquote/);

  const schema = await runWorkflow({
    source: "return await agent('CLAIMS', { schema: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } } })",
    runAgent: async ({ prompt }) => (/rejected your previous report/.test(prompt) ? '{"n": 2}' : Promise.reject(rejected('unfetched')))
  });
  assert.deepEqual(schema.result, { n: 2 });
});

test('workflow reports may cite and quote pages a sibling agent of the run fetched', () => {
  clearPageStore();
  rememberPage('https://example.com/spec', 'The protocol requires every message to carry a monotonically increasing sequence number.');
  const report = 'The spec says "every message to carry a monotonically increasing sequence number" ([spec](https://example.com/spec)).';
  const writerIssues = checkReport(report, []);
  assert.equal(writerIssues.length, 1, 'alone, the tool-less report writer cites a page it never fetched');
  const runEvidence = [];
  const sibling = { events: [{ kind: 'fetch', tool: 'fetch_url', url: 'https://example.com/spec', numbers: [], seq: 1 }], issues: [], text: 'fetched it' };
  assert.deepEqual(workflowReportIssues(sibling, 'fetched it', runEvidence), []);
  assert.equal(runEvidence.length, 1);
  assert.deepEqual(workflowReportIssues({ events: [], issues: writerIssues, text: report }, report, runEvidence), []);

  const misquote = report.replace('monotonically increasing sequence number', 'unique random identifier chosen by the client');
  const issues = workflowReportIssues({ events: [], issues: checkReport(misquote, runEvidence), text: misquote }, misquote, runEvidence);
  assert.equal(issues.length, 1, 'the run\'s evidence does not excuse a misquote');
  assert.match(issues[0].reason, /does not contain/);
  const unfetched = 'See https://example.com/other.';
  assert.equal(workflowReportIssues({ events: [], issues: checkReport(unfetched, []), text: unfetched }, unfetched, runEvidence).length, 1);
  const code = [{ domain: 'code', reason: 'says tests pass without a passing check' }];
  assert.deepEqual(workflowReportIssues({ events: [], issues: code, text: 'All tests pass.' }, 'All tests pass.', runEvidence), code, 'code issues are never excused by siblings');
});

test('end to end: a workflow agent citing a page it never fetched is retried and its fixed report is used', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-wf-verify-'));
  const env = { ...process.env, HOME: root, OASIS_CONFIG_DIR: path.join(root, '.oasis-config'), OASIS_AGENT_EXPERIENCE: '0' };
  const researchPrompts = [];
  const { config } = await scriptedModel(t, [(payload) => {
    const user = lastUser(payload);
    const last = payload.messages[payload.messages.length - 1];
    if (user.startsWith('RESEARCH')) {
      researchPrompts.push(user);
      return { content: researchPrompts.length === 1 ? 'The limit is documented at https://example.com/never-fetched.' : 'I could not fetch a source, so the limit is unverified.' };
    }
    if (last.role === 'tool') return { content: 'Workflow finished.' };
    return toolCall('w1', 'workflow', { script: "return await agent('RESEARCH the rate limit', { label: 'research' })" });
  }]);
  config.maxSteps = 30;
  const session = await createSession({ root, config, settings, env });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'run it', { env });
  const payload = JSON.parse(session.messages.find((m) => m.role === 'tool').content);
  assert.equal(payload.status, 'completed');
  assert.equal(payload.result, 'I could not fetch a source, so the limit is unverified.');
  assert.equal(researchPrompts.length, 2);
  assert.match(researchPrompts[1], /OASIS rejected your previous report: .*never-fetched/);
});
