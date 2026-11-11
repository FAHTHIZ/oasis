import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { startOasisWebServer } from '../src/web.mjs';
import { saveConfig } from '../src/config.mjs';
import { setWorkspaceTrust } from '../src/settings.mjs';
import { basicAuthToken, normalizeRepoUrl } from '../src/cursor-agents-api.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const TOKEN = 'test-runtime-token-0123456789abcdef';

function lastUserText(payload) {
  const users = (payload.messages || []).filter((message) => message.role === 'user');
  const last = users.at(-1);
  if (!last) return '';
  return typeof last.content === 'string' ? last.content : (last.content || []).map((part) => part.text || '').join(' ');
}

// One scripted model for every test server: the prompt decides what it does.
//   "WAIT"  holds the reply until gate.release() (to test busy, steer and cancel)
//   "READ"  reads notes.txt with a tool first (to test tool_call stream events)
async function harness(t, { git = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-cursor-api-'));
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, '.config-oasis'), HOME: root };
  const saved = { OASIS_CONFIG_DIR: process.env.OASIS_CONFIG_DIR, HOME: process.env.HOME };
  Object.assign(process.env, { OASIS_CONFIG_DIR: env.OASIS_CONFIG_DIR, HOME: root });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  await writeFile(path.join(root, 'notes.txt'), 'cursor-compatible fixture\n');
  if (git) {
    const run = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
    run('init', '-q', '-b', 'main');
    run('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', 'notes.txt');
    run('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    run('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  }
  await setWorkspaceTrust(root, true, env);
  const gate = { waiting: [], release() { for (const resolve of this.waiting.splice(0)) resolve(); } };
  const model = await scriptedModel(t, [async (payload) => {
    const text = lastUserText(payload);
    const toolMessages = (payload.messages || []).filter((message) => message.role === 'tool');
    if (/WAIT/.test(text) && !toolMessages.length) await new Promise((resolve) => gate.waiting.push(resolve));
    if (/READ/.test(text) && !toolMessages.length) return toolCall('r1', 'read_file', { path: 'notes.txt' });
    return { content: 'Done: ' + text.replace(/\s+/g, ' ').slice(0, 60) };
  }]);
  t.after(() => gate.release());
  await saveConfig(model.config, { env });
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: TOKEN, refreshModelCatalog: false, webhookRetryDelaysMs: [50, 50] });
  t.after(async () => { gate.release(); await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.port;
  const auth = { authorization: 'Bearer ' + TOKEN };
  const call = async (method, url, body, headers = auth) => {
    const response = await fetch(base + url, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: response.status, body: json, text, headers: response.headers };
  };
  const waitRun = async (agentId, runId, wanted = ['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED'], ms = 10000) => {
    const deadline = Date.now() + ms;
    let last;
    while (Date.now() < deadline) {
      last = await call('GET', '/v1/agents/' + agentId + '/runs/' + runId);
      assert.equal(last.status, 200, last.text);
      if (wanted.includes(last.body.status)) return last.body;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail('run did not reach ' + wanted.join('/') + ': ' + JSON.stringify(last && last.body));
  };
  const waitFor = async (check, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
    assert.fail('condition not met in time');
  };
  return { root, env, app, base, call, waitRun, waitFor, gate, model };
}

test('helpers: Basic auth needs the key as username with an empty password; repo URLs normalise', () => {
  assert.equal(basicAuthToken('Basic ' + Buffer.from('abc:').toString('base64')), 'abc');
  assert.equal(basicAuthToken('Basic ' + Buffer.from('abc:secret').toString('base64')), null);
  assert.equal(basicAuthToken('Bearer abc'), null);
  assert.equal(normalizeRepoUrl('git@github.com:Acme/Widgets.git'), 'https://github.com/acme/widgets');
  assert.equal(normalizeRepoUrl('https://github.com/acme/widgets/'), 'https://github.com/acme/widgets');
  assert.equal(normalizeRepoUrl('github.com/acme/widgets'), 'https://github.com/acme/widgets');
});

test('Cursor API auth: Bearer and Basic work, wrong keys get 401 in Cursor\'s error shape and count toward lockout', async (t) => {
  const h = await harness(t);
  const bearer = await h.call('GET', '/v1/me');
  assert.equal(bearer.status, 200);
  assert.equal(bearer.body.apiKeyName, 'OASIS web access key');
  assert.ok(!Number.isNaN(Date.parse(bearer.body.createdAt)));
  assert.equal(bearer.body.userEmail, undefined);
  const basic = await h.call('GET', '/v1/me', null, { authorization: 'Basic ' + Buffer.from(TOKEN + ':').toString('base64') });
  assert.equal(basic.status, 200);
  const none = await h.call('GET', '/v1/models', null, {});
  assert.equal(none.status, 401);
  assert.equal(none.body.error.code, 'unauthorized');
  const wrong = await h.call('GET', '/v1/agents', null, { authorization: 'Bearer wrong-key' });
  assert.equal(wrong.status, 401);
  const withPassword = await h.call('GET', '/v1/me', null, { authorization: 'Basic ' + Buffer.from(TOKEN + ':x').toString('base64') });
  assert.equal(withPassword.status, 401);
  // Basic auth is only for the Cursor-compatible paths; /api keeps Bearer only.
  const apiBasic = await h.call('GET', '/api/status', null, { authorization: 'Basic ' + Buffer.from(TOKEN + ':').toString('base64') });
  assert.equal(apiBasic.status, 401);
  // A foreign Host header is refused before auth (DNS-rebinding protection).
  const rebinding = await new Promise((resolve, reject) => {
    import('node:http').then(({ request }) => {
      const req = request({ host: '127.0.0.1', port: h.app.port, path: '/v1/me', headers: { host: 'evil.example', authorization: 'Bearer ' + TOKEN } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
  });
  assert.equal(rebinding, 421);
  // 10 wrong keys from one address lock it out, for this API too.
  for (let i = 0; i < 10; i++) await h.call('GET', '/v1/me', null, { authorization: 'Bearer wrong-' + i });
  const locked = await h.call('GET', '/v1/me');
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error.code, 'rate_limited');
});

test('Cursor API v1: models, repositories, create, poll to FINISHED, usage, list and pagination', async (t) => {
  const h = await harness(t);
  const models = await h.call('GET', '/v1/models');
  assert.equal(models.status, 200);
  assert.deepEqual(models.body.items.map((item) => item.id), ['fixture']);
  assert.deepEqual((await h.call('GET', '/v0/models')).body, { models: ['fixture'] });
  const repos = await h.call('GET', '/v1/repositories');
  assert.deepEqual(repos.body, { items: [{ url: pathToFileURL(h.root).href }] });
  const v0repos = await h.call('GET', '/v0/repositories');
  assert.equal(v0repos.body.repositories[0].repository, pathToFileURL(h.root).href);

  const created = await h.call('POST', '/v1/agents', { prompt: { text: 'Say hello' }, name: 'Greeter', repos: [{ url: pathToFileURL(h.root).href }] });
  assert.equal(created.status, 201, created.text);
  const { agent, run } = created.body;
  assert.match(agent.id, /^bc-[0-9a-f-]{36}$/);
  assert.match(run.id, /^run-[0-9a-f-]{36}$/);
  assert.equal(agent.name, 'Greeter');
  assert.equal(agent.status, 'ACTIVE');
  assert.equal(agent.latestRunId, run.id);
  assert.deepEqual(agent.env, { type: 'machine', name: 'oasis' });
  assert.equal(agent.workOnCurrentBranch, true);
  assert.equal(agent.autoCreatePR, false);
  assert.equal(run.agentId, agent.id);
  assert.ok(['CREATING', 'RUNNING', 'FINISHED'].includes(run.status));
  const finished = await h.waitRun(agent.id, run.id);
  assert.equal(finished.status, 'FINISHED');
  assert.equal(finished.result, 'Done: Say hello');
  assert.ok(Number.isInteger(finished.durationMs) && finished.durationMs >= 0);
  assert.ok(finished.oasis.jobId);

  const usage = await h.call('GET', '/v1/agents/' + agent.id + '/usage');
  assert.equal(usage.status, 200);
  assert.equal(usage.body.runs.length, 1);
  assert.equal(usage.body.runs[0].id, run.id);
  assert.equal(usage.body.totalUsage.inputTokens, 10);
  assert.equal(usage.body.totalUsage.outputTokens, 5);
  assert.equal(usage.body.totalUsage.totalTokens, 15);
  assert.equal((await h.call('GET', '/v1/agents/' + agent.id + '/usage?runId=run-00000000-0000-4000-8000-000000000000')).body.error.code, 'run_not_found');

  // Without repos, the agent uses the served folder; a client-supplied agentId is kept.
  const chosenId = 'bc-11111111-2222-4333-8444-555555555555';
  const second = await h.call('POST', '/v1/agents', { prompt: { text: 'Second task' }, agentId: chosenId });
  assert.equal(second.status, 201, second.text);
  assert.equal(second.body.agent.id, chosenId);
  await h.waitRun(chosenId, second.body.run.id);
  const conflict = await h.call('POST', '/v1/agents', { prompt: { text: 'again' }, agentId: chosenId });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'agent_id_conflict');

  const page1 = await h.call('GET', '/v1/agents?limit=1');
  assert.equal(page1.body.items.length, 1);
  assert.equal(page1.body.items[0].id, chosenId, 'newest first');
  assert.ok(page1.body.nextCursor);
  const page2 = await h.call('GET', '/v1/agents?limit=1&cursor=' + page1.body.nextCursor);
  assert.equal(page2.body.items[0].id, agent.id);
  assert.equal(Object.hasOwn(page2.body, 'nextCursor'), false, 'nextCursor is omitted on the last page');
  assert.equal((await h.call('GET', '/v1/agents?limit=0')).body.error.code, 'validation_error');

  const got = await h.call('GET', '/v1/agents/' + agent.id);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.repos, [{ url: pathToFileURL(h.root).href }]);
  assert.equal((await h.call('GET', '/v1/agents/bc-00000000-0000-4000-8000-000000000000')).body.error.code, 'agent_not_found');
  const runs = await h.call('GET', '/v1/agents/' + agent.id + '/runs');
  assert.deepEqual(runs.body.items.map((item) => item.id), [run.id]);
});

test('Cursor API v1: follow-ups, 409 agent_busy, steer, cancel, archive and delete', async (t) => {
  const h = await harness(t);
  const created = await h.call('POST', '/v1/agents', { prompt: { text: 'First turn' } });
  assert.equal(created.status, 201, created.text);
  const agentId = created.body.agent.id;
  await h.waitRun(agentId, created.body.run.id);

  // A follow-up continues the same OASIS conversation.
  const follow = await h.call('POST', '/v1/agents/' + agentId + '/runs', { prompt: { text: 'Please WAIT for me' } });
  assert.equal(follow.status, 201, follow.text);
  const busyRun = follow.body.run;
  await h.waitFor(() => h.gate.waiting.length > 0);
  const busy = await h.call('POST', '/v1/agents/' + agentId + '/runs', { prompt: { text: 'another' } });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error.code, 'agent_busy');
  // One task per folder: another agent cannot start while this one works.
  const other = await h.call('POST', '/v1/agents', { prompt: { text: 'parallel' } });
  assert.equal(other.status, 409);
  assert.equal(other.body.error.code, 'workspace_busy');
  const badSteer = await h.call('POST', '/v1/agents/' + agentId + '/runs', { prompt: { text: 'x' }, delivery: 'steer', model: { id: 'fixture' }, mode: 'plan' });
  assert.equal(badSteer.status, 400);
  assert.equal(badSteer.body.error.message, '"model", "mode" are not allowed with delivery "steer"');
  const steer = await h.call('POST', '/v1/agents/' + agentId + '/runs', { prompt: { text: 'also mention steering' }, delivery: 'steer' });
  assert.equal(steer.status, 202, steer.text);
  assert.deepEqual(steer.body, { delivery: 'steered', runId: busyRun.id });
  h.gate.release();
  const done = await h.waitRun(agentId, busyRun.id);
  assert.equal(done.status, 'FINISHED');
  const sentToModel = JSON.stringify(h.model.requests.at(-1).messages);
  assert.match(sentToModel, /First turn/, 'the follow-up carries the earlier conversation');
  assert.match(sentToModel, /also mention steering/, 'the steered prompt reached the running turn');

  // Cancel an active run; cancelling again is 409 run_not_cancellable.
  const toCancel = await h.call('POST', '/v1/agents/' + agentId + '/runs', { prompt: { text: 'WAIT forever' } });
  assert.equal(toCancel.status, 201, toCancel.text);
  await h.waitFor(() => h.gate.waiting.length > 0);
  const cancelled = await h.call('POST', '/v1/agents/' + agentId + '/runs/' + toCancel.body.run.id + '/cancel');
  assert.equal(cancelled.status, 200);
  assert.deepEqual(cancelled.body, { id: toCancel.body.run.id });
  const ended = await h.waitRun(agentId, toCancel.body.run.id);
  assert.equal(ended.status, 'CANCELLED');
  const again = await h.call('POST', '/v1/agents/' + agentId + '/runs/' + toCancel.body.run.id + '/cancel');
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'run_not_cancellable');
  h.gate.release();

  // A steer with no running turn starts the next follow-up and says "queued".
  const queued = await h.call('POST', '/v1/agents/' + agentId + '/runs', { prompt: { text: 'queued note' }, delivery: 'steer' });
  assert.equal(queued.status, 202, queued.text);
  assert.deepEqual(queued.body, { delivery: 'queued' });
  const listed = await h.call('GET', '/v1/agents/' + agentId + '/runs');
  assert.equal(listed.body.items.length, 4);
  await h.waitRun(agentId, listed.body.items[0].id);

  // Archive is idempotent; an archived agent refuses follow-ups; unarchive restores it.
  assert.deepEqual((await h.call('POST', '/v1/agents/' + agentId + '/archive')).body, { id: agentId });
  assert.equal((await h.call('POST', '/v1/agents/' + agentId + '/archive')).status, 200);
  assert.equal((await h.call('GET', '/v1/agents/' + agentId)).body.status, 'ARCHIVED');
  assert.equal((await h.call('GET', '/v1/agents?includeArchived=false')).body.items.length, 0);
  const archivedFollow = await h.call('POST', '/v1/agents/' + agentId + '/runs', { prompt: { text: 'hi' } });
  assert.equal(archivedFollow.status, 409);
  assert.equal(archivedFollow.body.error.code, 'agent_archived');
  assert.deepEqual((await h.call('POST', '/v1/agents/' + agentId + '/unarchive')).body, { id: agentId });
  assert.equal((await h.call('GET', '/v1/agents/' + agentId)).body.status, 'ACTIVE');

  assert.deepEqual((await h.call('DELETE', '/v1/agents/' + agentId)).body, { id: agentId });
  assert.equal((await h.call('GET', '/v1/agents/' + agentId)).status, 404);
});

test('Cursor API v1: the run stream sends status, tool_call, assistant, result and done, and resumes with Last-Event-ID', async (t) => {
  const h = await harness(t);
  const created = await h.call('POST', '/v1/agents', { prompt: { text: 'READ the notes' } });
  assert.equal(created.status, 201, created.text);
  const { agent, run } = created.body;
  const streamUrl = '/v1/agents/' + agent.id + '/runs/' + run.id + '/stream';
  const response = await fetch(h.base + streamUrl, { headers: { authorization: 'Bearer ' + TOKEN, accept: 'text/event-stream' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.ok(Number(response.headers.get('x-cursor-stream-retention-seconds')) > 0);
  const raw = await response.text();
  const events = raw.trim().split(/\n\n+/).map((block) => {
    const lines = Object.fromEntries(block.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]));
    return { id: lines.id, event: lines.event, data: JSON.parse(lines.data) };
  });
  assert.equal(events[0].event, 'status');
  assert.equal(events[0].id, undefined, 'the leading status event has no id');
  assert.equal(events[0].data.runId, run.id);
  const tools = events.filter((event) => event.event === 'tool_call');
  assert.deepEqual(tools.map((event) => [event.data.name, event.data.status]), [['read_file', 'running'], ['read_file', 'completed']]);
  assert.equal(tools[0].data.callId, 'r1');
  assert.match(JSON.stringify(tools[1].data.result), /cursor-compatible fixture/);
  const result = events.find((event) => event.event === 'result');
  assert.equal(result.data.status, 'FINISHED');
  assert.equal(result.data.text, 'Done: READ the notes');
  assert.equal(events.at(-1).event, 'done');

  // Resume after the first tool event: replays only what came later.
  const resumed = await (await fetch(h.base + streamUrl, { headers: { authorization: 'Bearer ' + TOKEN, 'last-event-id': tools[0].id } })).text();
  assert.match(resumed, /^event: status/);
  assert.equal((resumed.match(/event: tool_call/g) || []).length, 1);
  assert.match(resumed, /event: done/);
  const bad = await h.call('GET', streamUrl, null, { authorization: 'Bearer ' + TOKEN, 'last-event-id': '3-deadbeef' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'invalid_last_event_id');
});

test('Cursor API: unsupported fields and other repositories are refused with clear 4xx errors', async (t) => {
  const h = await harness(t, { git: true });
  const repos = await h.call('GET', '/v1/repositories');
  assert.deepEqual(repos.body, { items: [{ url: 'https://github.com/acme/widgets' }] });
  assert.deepEqual((await h.call('GET', '/v0/repositories')).body, { repositories: [{ owner: 'acme', name: 'widgets', repository: 'https://github.com/acme/widgets' }] });

  const cases = [
    [{ prompt: { text: 'x' }, repos: [{ url: 'https://github.com/other/repo' }] }, 400, 'repository_access'],
    [{ prompt: { text: 'x' }, repos: [{ url: 'https://github.com/acme/widgets', startingRef: 'develop' }] }, 400, 'invalid_branch_name'],
    [{ prompt: { text: 'x' }, repos: [{ url: 'https://github.com/acme/widgets', prUrl: 'https://github.com/acme/widgets/pull/1' }] }, 400, 'validation_error'],
    [{ prompt: { text: 'x' }, repos: [{ url: 'https://github.com/acme/widgets' }, { url: 'https://github.com/acme/other' }] }, 400, 'validation_error'],
    [{ prompt: { text: 'x' }, autoCreatePR: true }, 400, 'validation_error'],
    [{ prompt: { text: 'x' }, envVars: { A: 'b' } }, 400, 'validation_error'],
    [{ prompt: { text: 'x' }, mcpServers: [{ name: 'a', url: 'https://example.com/mcp' }] }, 400, 'validation_error'],
    [{ prompt: { text: 'x' }, customSubagents: [{ name: 'a', description: 'b', prompt: 'c' }] }, 400, 'validation_error'],
    [{ prompt: { text: 'x' }, env: { type: 'cloud' } }, 400, 'validation_error'],
    [{ prompt: { text: 'x', images: [{ url: 'https://example.com/a.png' }] } }, 400, 'validation_error'],
    [{ prompt: { text: 'x' }, model: { id: 'fixture', params: [{ id: 'thinking', value: 'high' }] } }, 400, 'invalid_model'],
    [{ prompt: {} }, 400, 'validation_error'],
    [{ prompt: { text: 'x' }, agentId: 'not-an-id' }, 400, 'validation_error']
  ];
  for (const [body, status, code] of cases) {
    const response = await h.call('POST', '/v1/agents', body);
    assert.equal(response.status, status, JSON.stringify(body) + ' -> ' + response.text);
    assert.equal(response.body.error.code, code, JSON.stringify(body));
    assert.equal(typeof response.body.error.message, 'string');
  }
  const v0cases = [
    [{ prompt: { text: 'x' } }, 'repository_required'],
    [{ prompt: { text: 'x' }, source: { repository: 'https://github.com/other/repo' } }, 'repository_access'],
    [{ prompt: { text: 'x' }, source: { prUrl: 'https://github.com/acme/widgets/pull/1' } }, 'validation_error'],
    [{ prompt: { text: 'x' }, source: { repository: 'https://github.com/acme/widgets' }, target: { autoCreatePr: true } }, 'validation_error'],
    [{ prompt: { text: 'x' }, source: { repository: 'https://github.com/acme/widgets' }, target: { branchName: 'feature/x' } }, 'validation_error'],
    [{ prompt: { text: 'x' }, source: { repository: 'https://github.com/acme/widgets' }, webhook: { url: 'http://example.com/hook' } }, 'validation_error'],
    [{ prompt: { text: 'x' }, source: { repository: 'https://github.com/acme/widgets' }, webhook: { url: 'https://example.com/hook', secret: 'too-short' } }, 'validation_error']
  ];
  for (const [body, code] of v0cases) {
    const response = await h.call('POST', '/v0/agents', body);
    assert.equal(response.status, 400, JSON.stringify(body) + ' -> ' + response.text);
    assert.equal(response.body.error.code, code, JSON.stringify(body));
  }
  assert.equal((await h.call('GET', '/v1/agents')).body.items.length, 0, 'refused requests create no agents');
  assert.equal((await h.call('GET', '/v1/environments')).body.error.code, 'not_found');

  // The served repository, by remote URL (SSH form too) and its current branch, is accepted.
  const ok = await h.call('POST', '/v1/agents', { prompt: { text: 'hi' }, repos: [{ url: 'git@github.com:acme/widgets.git', startingRef: 'main' }] });
  assert.equal(ok.status, 201, ok.text);
  assert.deepEqual(ok.body.agent.repos, [{ url: 'https://github.com/acme/widgets', startingRef: 'main' }]);
  await h.waitRun(ok.body.agent.id, ok.body.run.id);
});

test('Cursor API v0: launch, status with summary, conversation, follow-up, stop, and a signed statusChange webhook', async (t) => {
  const h = await harness(t, { git: true });
  const deliveries = [];
  const receiver = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    deliveries.push({ headers: req.headers, raw });
    // The first delivery fails once to exercise the retry.
    res.writeHead(deliveries.length === 1 ? 503 : 200);
    res.end();
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => receiver.close(resolve)));
  const secret = 'a-webhook-secret-that-is-at-least-32-chars';

  const launch = await h.call('POST', '/v0/agents', {
    prompt: { text: 'Write the summary' },
    model: 'default',
    source: { repository: 'https://github.com/acme/widgets', ref: 'main' },
    webhook: { url: 'http://127.0.0.1:' + receiver.address().port + '/hook', secret }
  });
  assert.equal(launch.status, 201, launch.text);
  const agent = launch.body;
  assert.match(agent.id, /^bc-/);
  assert.ok(['CREATING', 'RUNNING', 'FINISHED'].includes(agent.status));
  assert.deepEqual(agent.source, { repository: 'https://github.com/acme/widgets', ref: 'main' });
  assert.equal(agent.target.branchName, 'main');
  assert.equal(agent.target.autoCreatePr, false);
  assert.ok(agent.createdAt);
  assert.doesNotMatch(launch.text, new RegExp(secret), 'the webhook secret is never echoed');

  await h.waitFor(() => deliveries.length >= 2, 8000);
  const [first, second] = deliveries;
  assert.equal(first.raw, second.raw, 'a retry resends the same body');
  const delivered = second;
  assert.equal(delivered.headers['x-webhook-event'], 'statusChange');
  assert.equal(delivered.headers['user-agent'], 'Cursor-Agent-Webhook/1.0');
  assert.match(delivered.headers['x-webhook-id'], /^msg_/);
  const expected = 'sha256=' + createHmac('sha256', secret).update(delivered.raw).digest('hex');
  assert.equal(delivered.headers['x-webhook-signature'], expected);
  const payload = JSON.parse(delivered.raw);
  assert.equal(payload.event, 'statusChange');
  assert.equal(payload.id, agent.id);
  assert.equal(payload.status, 'FINISHED');
  assert.equal(payload.summary, 'Done: Write the summary');
  assert.deepEqual(payload.source, { repository: 'https://github.com/acme/widgets', ref: 'main' });
  assert.ok(!Number.isNaN(Date.parse(payload.timestamp)));

  const status = await h.call('GET', '/v0/agents/' + agent.id);
  assert.equal(status.body.status, 'FINISHED');
  assert.equal(status.body.summary, 'Done: Write the summary');
  const list = await h.call('GET', '/v0/agents');
  assert.deepEqual(list.body.agents.map((item) => item.id), [agent.id]);
  assert.equal(Object.hasOwn(list.body, 'nextCursor'), false);

  const followup = await h.call('POST', '/v0/agents/' + agent.id + '/followup', { prompt: { text: 'And a WAIT step' } });
  assert.equal(followup.status, 200, followup.text);
  assert.deepEqual(followup.body, { id: agent.id });
  await h.waitFor(() => h.gate.waiting.length > 0);
  assert.equal((await h.call('GET', '/v0/agents/' + agent.id)).body.status, 'RUNNING');
  const busy = await h.call('POST', '/v0/agents/' + agent.id + '/followup', { prompt: { text: 'more' } });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error.code, 'agent_busy');
  const stop = await h.call('POST', '/v0/agents/' + agent.id + '/stop');
  assert.deepEqual(stop.body, { id: agent.id });
  await h.waitFor(async () => (await h.call('GET', '/v0/agents/' + agent.id)).body.status === 'FINISHED');
  h.gate.release();
  assert.equal((await h.call('POST', '/v0/agents/' + agent.id + '/stop')).status, 409);
  await h.waitFor(() => deliveries.length >= 3, 8000);
  assert.equal(JSON.parse(deliveries[2].raw).status, 'FINISHED', 'a stopped agent reports FINISHED (v0 has no cancelled status)');

  const conversation = await h.call('GET', '/v0/agents/' + agent.id + '/conversation');
  assert.equal(conversation.status, 200);
  assert.equal(conversation.body.id, agent.id);
  const types = conversation.body.messages.map((message) => message.type);
  assert.deepEqual(types.slice(0, 3), ['user_message', 'assistant_message', 'user_message']);
  assert.equal(conversation.body.messages[0].text, 'Write the summary');
  assert.equal(conversation.body.messages[1].text, 'Done: Write the summary');
  assert.match(conversation.body.messages[0].id, /^msg_/);

  const me = await h.call('GET', '/v0/me');
  assert.equal(me.body.apiKeyName, 'OASIS web access key');
  assert.deepEqual((await h.call('DELETE', '/v0/agents/' + agent.id)).body, { id: agent.id });
  assert.equal((await h.call('GET', '/v0/agents/' + agent.id)).status, 404);
});

test('Cursor API: agents and finished runs survive a server restart', async (t) => {
  const h = await harness(t);
  const created = await h.call('POST', '/v1/agents', { prompt: { text: 'Persist me' } });
  const { agent, run } = created.body;
  await h.waitRun(agent.id, run.id);
  await h.app.close();
  const app = await startOasisWebServer({ root: h.root, host: '127.0.0.1', port: 0, env: h.env, token: TOKEN, refreshModelCatalog: false });
  t.after(() => app.close());
  const response = await fetch('http://127.0.0.1:' + app.port + '/v1/agents/' + agent.id + '/runs/' + run.id, { headers: { authorization: 'Bearer ' + TOKEN } });
  const body = await response.json();
  assert.equal(body.status, 'FINISHED');
  assert.equal(body.result, 'Done: Persist me');
});
