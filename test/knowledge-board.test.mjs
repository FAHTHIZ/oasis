import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { createEvidenceLedger, recordEvidence } from '../src/evidence-ledger.mjs';
import { createKnowledgeBoard, groundFinding, knowledgePromptSection, runKnowledgeTool, sanitizeKnowledgeBoard, searchKnowledge } from '../src/knowledge-board.mjs';
import { SESSION_READ_ONLY_TOOLS, SESSION_TOOL_NAMES } from '../src/session-tools.mjs';

function agent(id, events = []) {
  const ledger = createEvidenceLedger();
  for (const event of events) recordEvidence(ledger, event);
  return { agentId: id, agentType: id === 'main' ? '' : 'Explore', evidenceLedger: ledger };
}

test('knowledge tools are session tools that read-only agents may use', () => {
  assert.ok(SESSION_TOOL_NAMES.has('knowledge_post'));
  assert.ok(SESSION_TOOL_NAMES.has('knowledge_search'));
  assert.ok(SESSION_READ_ONLY_TOOLS.includes('knowledge_post'), 'posting touches only the session board, never the workspace');
});

test('a finding citing a fetched page is grounded; one citing an unfetched page is refused', () => {
  const fetched = [{ kind: 'fetch', tool: 'fetch_url', url: 'https://example.com/limits', numbers: ['500'] }];
  const ok = groundFinding('The API allows 500 requests per minute, see https://example.com/limits.', [], fetched);
  assert.deepEqual(ok.issues, []);
  assert.ok(ok.grounds.some((ground) => /fetched https:\/\/example\.com\/limits/.test(ground)));
  const refused = groundFinding('See https://example.com/other for the limit.', [], fetched);
  assert.equal(refused.issues[0].domain, 'research');
  const plain = groundFinding('The retry logic lives in src/providers.mjs.', [], []);
  assert.deepEqual(plain, { issues: [], grounds: [] });
});

test('posts are labelled, duplicates corroborate, and only the author or main can retract', () => {
  const board = createKnowledgeBoard();
  const first = agent('agent_1', [{ kind: 'fetch', tool: 'fetch_url', url: 'https://example.com/limits', numbers: [] }]);
  const second = agent('agent_2');
  first.knowledgeBoard = board;
  second.knowledgeBoard = board;
  const main = { agentId: '', knowledgeBoard: board };

  const posted = runKnowledgeTool(first, 'knowledge_post', { claim: 'Rate limits are documented on the limits page of the example API.', sources: ['https://example.com/limits'], tags: ['API'] });
  assert.equal(posted.posted, 'k_1');
  assert.equal(posted.status, 'grounded');
  assert.deepEqual(posted.finding.tags, ['api']);

  assert.throws(() => runKnowledgeTool(second, 'knowledge_post', { claim: 'The docs at https://example.com/secret say so.' }), /Not posted: .*never fetched/);

  const noted = runKnowledgeTool(second, 'knowledge_post', { claim: 'Retry logic for providers lives in src/providers.mjs.' });
  assert.equal(noted.status, 'noted');
  assert.match(noted.note, /lead to verify/);

  const again = runKnowledgeTool(second, 'knowledge_post', { claim: 'Rate limits are documented on the limits page of the example API.' });
  assert.equal(again.corroborated, 'k_1');
  assert.deepEqual(again.finding.corroborated_by, ['agent_2']);
  assert.equal(board.entries.length, 2);

  const refined = runKnowledgeTool(second, 'knowledge_post', { claim: 'Retry logic for providers lives in src/providers.mjs near the fallback chain.' });
  assert.equal(refined.updated, 'k_2');

  assert.throws(() => runKnowledgeTool(second, 'knowledge_post', { retract: 'k_1' }), /Only agent_1/);
  assert.deepEqual(runKnowledgeTool(main, 'knowledge_post', { retract: 'k_2', reason: 'wrong file' }), { retracted: 'k_2' });

  const search = runKnowledgeTool(main, 'knowledge_search', { query: 'rate limit' });
  assert.deepEqual(search.findings.map((item) => item.id), ['k_1']);
  assert.equal(search.total, 1);
  assert.equal(searchKnowledge(board, { query: 'retry', includeRetracted: true })[0].id, 'k_2');
});

test('the board survives a save round trip and drops malformed entries', () => {
  const restored = sanitizeKnowledgeBoard({ nextId: 2, entries: [
    { id: 'k_7', claim: 'kept', status: 'grounded', author: 'agent_1', at: '2026-01-01T00:00:00Z' },
    { id: 'bad', claim: 'dropped' },
    { id: 'k_8', claim: '' },
    { id: 'k_7', claim: 'duplicate id' }
  ] });
  assert.deepEqual(restored.entries.map((entry) => entry.claim), ['kept']);
  assert.equal(restored.nextId, 8, 'never reuses an id');
  assert.equal(JSON.stringify(sanitizeKnowledgeBoard(JSON.parse(JSON.stringify(restored)))), JSON.stringify(restored));
});

test('the prompt section lists relevant findings within its budget', () => {
  const session = { knowledgeBoard: createKnowledgeBoard() };
  assert.equal(knowledgePromptSection(session, 'anything'), '');
  const poster = { agentId: 'agent_1', knowledgeBoard: session.knowledgeBoard };
  runKnowledgeTool(poster, 'knowledge_post', { claim: 'The billing module computes invoices in src/billing.mjs.' });
  runKnowledgeTool(poster, 'knowledge_post', { claim: 'Websocket reconnects are handled by the gateway client.' });
  const section = knowledgePromptSection(session, 'Fix the invoice rounding bug in billing');
  assert.match(section, /^SHARED KNOWLEDGE BOARD: agents of this session have posted 2 findings/);
  assert.match(section, /k_1 \[noted, agent_1\] The billing module/);
  const tight = knowledgePromptSection(session, 'billing', { budget: 330 });
  assert.ok(tight.length <= 330);
  assert.doesNotMatch(tight, /k_1/, 'entries past the budget are left out');
});

// The parent delegates twice in a row. The first child posts a finding; the
// second child starts with it in its system prompt, and the parent can search it.
test('subagents share the parent session board end to end', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-knowledge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = path.join(root, '.config-oasis');
  await mkdir(configDir, { recursive: true });
  let secondSystem = '';
  let postResult = null;
  let refusedResult = null;
  let parentStep = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    const system = String(payload.messages[0].content);
    const tools = payload.messages.filter((m) => m.role === 'tool');
    let message;
    if (/SUBAGENT MODE/.test(system)) {
      const user = payload.messages.find((m) => m.role === 'user');
      if (/first look/.test(String(user && user.content))) {
        if (tools.length === 0) message = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'knowledge_post', arguments: JSON.stringify({ claim: 'Session files are written by the saveSession function in src/sessions.mjs.', tags: ['sessions'] }) } }] };
        else if (tools.length === 1) { postResult = JSON.parse(tools[0].content); message = { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'knowledge_post', arguments: JSON.stringify({ claim: 'The format is specified at https://example.com/spec.' }) } }] }; }
        else { refusedResult = tools[1].content; message = { role: 'assistant', content: 'Found where sessions are saved.' }; }
      } else {
        secondSystem = system;
        message = { role: 'assistant', content: 'Used the shared finding.' };
      }
    } else {
      parentStep += 1;
      const call = (id, name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      if (parentStep === 1) message = call('p1', 'task', { description: 'first', prompt: 'first look: where are session files saved?', subagent_type: 'explore' });
      else if (parentStep === 2) message = call('p2', 'task', { description: 'second', prompt: 'Change how session files are saved.', subagent_type: 'explore' });
      else message = { role: 'assistant', content: 'done' };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...process.env, OASIS_CONFIG_DIR: configDir, OASIS_SUBAGENT_EFFORT: '', CLAUDE_CODE_SUBAGENT_EFFORT: '', OASIS_AGENT_EXPERIENCE: '0' };
  const session = await createSession({ root, env, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 6 } });
  await runAgentTurn(session, 'go', { autoApprove: true, env });

  assert.equal(postResult && postResult.posted, 'k_1', 'the read-only Explore child could post');
  assert.equal(postResult.status, 'noted');
  assert.match(String(refusedResult), /Not posted: .*never fetched/);
  assert.match(secondSystem, /SHARED KNOWLEDGE BOARD/);
  assert.match(secondSystem, /k_1 \[noted, agent_1\] Session files are written by the saveSession function/);
  assert.equal(session.knowledgeBoard.entries.length, 1);
  assert.equal(session.knowledgeBoard.entries[0].authorType, 'explore');
  const found = runKnowledgeTool(session, 'knowledge_search', { query: 'session files' });
  assert.equal(found.findings[0].id, 'k_1');
});
