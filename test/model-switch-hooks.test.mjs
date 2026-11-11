import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, realpath } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { canonicalModelName, modelSwitchCost, switchSessionModel } from '../src/model-switch.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

async function tmp(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'oasis-model-switch-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const settingsWith = (hooks) => ({ permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks, sandbox: { enabled: false }, shell: { enabled: false } });
const nodeHook = (code) => JSON.stringify(process.execPath) + ' -e ' + JSON.stringify(code);
// Saves stdin to FILE, then runs TAIL (JS) with the parsed input as `input`.
const recordingHook = (file, tail = '') => nodeHook('let s="";process.stdin.on("data",(c)=>s+=c);process.stdin.on("end",()=>{require("fs").writeFileSync(' + JSON.stringify(file) + ',s);const input=JSON.parse(s);' + tail + '})');
const group = (hook, matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [hook] });

test('canonicalModelName collapses aliases, dated, Bedrock and gateway ids', () => {
  const env = {};
  assert.equal(canonicalModelName('claude-opus-5', { env }), 'claude-opus-5');
  assert.equal(canonicalModelName('claude-opus-5[1m]', { env }), 'claude-opus-5');
  assert.equal(canonicalModelName('claude-sonnet-4-5-20250929', { env }), 'claude-sonnet-4-5');
  assert.equal(canonicalModelName('us.anthropic.claude-opus-4-6-v1:0', { env }), 'claude-opus-4-6');
  assert.equal(canonicalModelName('anthropic/claude-haiku-4-5', { env }), 'claude-haiku-4-5');
  assert.equal(canonicalModelName('claude-sonnet-4-5@20250929', { env }), 'claude-sonnet-4-5');
  assert.equal(canonicalModelName('opus', { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-20260101' } }), 'claude-opus-5');
  assert.equal(canonicalModelName('gpt-5.2', { env }), null);
  assert.equal(canonicalModelName('', { env }), null);
});

test('modelSwitchCost reports context tokens, cache warmth and a priced estimate', () => {
  const cold = modelSwitchCost({ config: {} }, 'unknown-model-x', {});
  assert.deepEqual(cold, { context_tokens: 0, prompt_cache_warm: false, cache_ttl: '5m', estimated_cache_write_usd: 0, pricing: 'default' });
  const session = { config: {}, lastMainUsage: { inputTokens: 1_000_000, outputTokens: 0, at: Date.now() } };
  const warm = modelSwitchCost(session, 'unknown-model-x', {});
  assert.equal(warm.context_tokens, 1_000_000);
  assert.equal(warm.prompt_cache_warm, true);
  assert.equal(warm.estimated_cache_write_usd, 3.75); // default $3/M input x 1.25 for a 5-minute write
  const custom = modelSwitchCost({ ...session, pricing: { 'my-model': { input: 2, output: 8, cacheWrite: 2.5 } } }, 'my-model', {});
  assert.equal(custom.pricing, 'configured');
  assert.equal(custom.estimated_cache_write_usd, 2.5);
  session.lastMainUsage.at = Date.now() - 6 * 60 * 1000;
  assert.equal(modelSwitchCost(session, 'x', {}).prompt_cache_warm, false);
  assert.equal(modelSwitchCost(session, 'x', { ENABLE_PROMPT_CACHING_1H: '1' }).prompt_cache_warm, true);
});

test('/model runs PreModelSwitch with Claude Code input fields; exit 2 keeps the model', async (t) => {
  const root = await tmp(t);
  const seen = path.join(root, 'pre.json');
  const { config } = await scriptedModel(t, [{ content: 'ok' }]);
  const hooks = { PreModelSwitch: [group({ type: 'command', command: recordingHook(seen, 'if(/opus-4-6/.test(input.to_model)){process.stderr.write("Opus 4.6 is retired.");process.exit(2)}') }, 'claude-opus-4-6')] };
  const session = await createSession({ root, config, settings: settingsWith(hooks) });
  t.after(() => closeSession(session));
  const sessionOptions = {};
  const blocked = await runBuiltinCommand('model', 'claude-opus-4-6-20260101', { root, session, env: {}, sessionOptions });
  assert.match(blocked.output, /Model unchanged \(fixture\): Opus 4\.6 is retired\./);
  assert.equal(session.config.model, 'fixture');
  assert.equal(sessionOptions.model, undefined);
  const input = JSON.parse(await readFile(seen, 'utf8'));
  assert.equal(input.hook_event_name, 'PreModelSwitch');
  assert.equal(input.from_model, 'fixture');
  assert.equal(input.to_model, 'claude-opus-4-6-20260101');
  assert.equal(input.requested_model, 'claude-opus-4-6-20260101');
  assert.equal(input.source, 'command');
  assert.equal(input.cwd, root);
  for (const key of ['context_tokens', 'prompt_cache_warm', 'cache_ttl', 'estimated_cache_write_usd', 'pricing']) assert.ok(key in input, key);
  assert.equal('model_canonical' in input, false);
  // The matcher compares the canonical name, so another model skips the hook.
  await rm(seen);
  const ok = await runBuiltinCommand('model', 'claude-sonnet-5', { root, session, env: {}, sessionOptions });
  assert.equal(ok.output, 'Model set to claude-sonnet-5.');
  assert.equal(session.config.model, 'claude-sonnet-5');
  assert.equal(sessionOptions.model, 'claude-sonnet-5');
  await assert.rejects(readFile(seen, 'utf8'));
});

test('PreModelSwitch "ask" uses the confirm prompt, and refuses where nobody can answer', async (t) => {
  const root = await tmp(t);
  const ask = nodeHook('process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({systemMessage:"Re-sends the context.",hookSpecificOutput:{hookEventName:"PreModelSwitch",permissionDecision:"ask",permissionDecisionReason:"Switching re-sends 180k tokens."}})))');
  const session = { root, config: { model: 'a' }, hooks: { PreModelSwitch: [group({ type: 'command', command: ask })] } };
  const questions = [];
  const declined = await switchSessionModel(session, { to: 'b', confirm: async (q) => { questions.push(q); return false; } });
  assert.equal(declined.ok, false);
  assert.equal(session.config.model, 'a');
  assert.match(questions[0], /Switching re-sends 180k tokens\. Continue\?/);
  assert.deepEqual(declined.messages, ['Re-sends the context.']);
  const accepted = await switchSessionModel(session, { to: 'b', confirm: async () => true });
  assert.equal(accepted.ok, true);
  assert.equal(session.config.model, 'b');
  const headless = await switchSessionModel(session, { to: 'c', source: 'sdk' });
  assert.equal(headless.ok, false);
  assert.match(headless.reason, /confirmation/);
  assert.equal(session.config.model, 'b');
});

test('PreModelSwitch deny wins over allow, and a timed-out hook blocks the switch', async (t) => {
  const root = await tmp(t);
  const decide = (decision, reason) => nodeHook('process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(' + JSON.stringify(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreModelSwitch', permissionDecision: decision, permissionDecisionReason: reason } })) + '))');
  const session = { root, config: { model: 'a' }, hooks: { PreModelSwitch: [group({ type: 'command', command: decide('allow', '') }), group({ type: 'command', command: decide('deny', 'Not on this project.') })] } };
  const denied = await switchSessionModel(session, { to: 'b' });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'Not on this project.');
  session.hooks = { PreModelSwitch: [group({ type: 'command', command: nodeHook('setTimeout(()=>{},5000)'), timeout: 1 })] };
  const slow = await switchSessionModel(session, { to: 'b' });
  assert.equal(slow.ok, false);
  assert.match(slow.reason, /timed out/);
  assert.equal(session.config.model, 'a');
});

test('PostModelSwitch output reaches the model with the next request; only the newest switch counts', async (t) => {
  const root = await tmp(t);
  const seen = path.join(root, 'post.json');
  const { config, requests } = await scriptedModel(t, [{ content: 'first' }, { content: 'second' }]);
  const echo = (text) => nodeHook('process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(' + JSON.stringify(text) + '))');
  const hooks = {
    PostModelSwitch: [
      group({ type: 'command', command: echo('Opus guidance: delegate implementation to subagents.') }, '.*opus.*'),
      group({ type: 'command', command: echo('Sonnet guidance: keep it short.') }, 'claude-sonnet-5'),
      group({ type: 'command', command: nodeHook('let s="";process.stdin.on("data",(c)=>s+=c);process.stdin.on("end",()=>require("fs").appendFileSync(' + JSON.stringify(seen) + ',s.trim()+"\\n"))') })
    ]
  };
  const session = await createSession({ root, config, settings: settingsWith(hooks) });
  t.after(() => closeSession(session));
  // The model id itself must still reach the scripted server, so the switch keeps
  // the fixture endpoint; only the name changes.
  await runBuiltinCommand('model', 'claude-opus-5', { root, session, env: {}, sessionOptions: {} });
  const firstSwitch = session.pendingModelSwitch;
  await runBuiltinCommand('model', 'claude-sonnet-5', { root, session, env: {}, sessionOptions: {} });
  // Both switches append to the same file and may finish in either order.
  await Promise.all([firstSwitch, session.pendingModelSwitch]);
  const input = (await readFile(seen, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).find((entry) => entry.to_model === 'claude-sonnet-5');
  assert.equal(input.hook_event_name, 'PostModelSwitch');
  assert.equal(input.from_model, 'claude-opus-5');
  assert.equal(input.to_model, 'claude-sonnet-5');
  assert.equal(input.source, 'command');
  await runAgentTurn(session, 'hello');
  const sent = JSON.stringify(requests[0].messages);
  assert.match(sent, /Sonnet guidance: keep it short\./);
  assert.doesNotMatch(sent, /Opus guidance/);
  assert.equal(requests[0].model, 'claude-sonnet-5');
  await runAgentTurn(session, 'again');
  assert.equal(JSON.stringify(requests[1].messages).match(/Sonnet guidance/g).length, 1, 'delivered once');
});

test('/add-dir fires DirectoryAdded in the background and opens the sandbox to the folder', async (t) => {
  const root = await tmp(t);
  const other = path.join(await tmp(t), 'other-repo');
  await mkdir(other);
  const seen = path.join(root, 'added.json');
  const { config } = await scriptedModel(t, [{ content: 'ok' }]);
  const session = await createSession({ root, config, settings: settingsWith({ DirectoryAdded: [group({ type: 'command', command: recordingHook(seen) }, 'slash_command')] }) });
  t.after(() => closeSession(session));
  session.sandbox = { enabled: true, writable: [root] };
  const result = await runBuiltinCommand('add-dir', other, { root, session, env: {}, sessionOptions: {} });
  assert.match(result.output, /Added additional working directory/);
  assert.ok(session.sandbox.writable.includes(other));
  let input = null;
  for (let i = 0; i < 100 && !input; i++) {
    input = await readFile(seen, 'utf8').then(JSON.parse, () => null);
    if (!input) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(input, 'DirectoryAdded hook ran');
  assert.equal(input.hook_event_name, 'DirectoryAdded');
  assert.equal(input.directory, other);
  assert.equal(input.source, 'slash_command');
  // Adding it again is not an addition, so the hook does not fire.
  await rm(seen);
  await runBuiltinCommand('add-dir', other, { root, session, env: {}, sessionOptions: {} });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await assert.rejects(readFile(seen, 'utf8'));
});
