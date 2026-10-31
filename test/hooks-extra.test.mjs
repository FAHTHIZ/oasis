import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession, compactHistoryIfNeeded } from '../src/agent.mjs';
import { loadSettings } from '../src/settings.mjs';
import { runHooks, describeHook } from '../src/hooks.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-hooks-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const settingsWith = (hooks) => ({ permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks, sandbox: { enabled: false }, shell: { enabled: false } });
const nodeHook = (code) => JSON.stringify(process.execPath) + ' -e ' + JSON.stringify(code);
// A hook that appends its payload to a JSON-lines file and prints `output`.
const recorder = (file, output = '') => nodeHook('let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{require("fs").appendFileSync(' + JSON.stringify(file) + ',d+"\\n");' + (output ? 'process.stdout.write(' + JSON.stringify(output) + ')' : '') + '})');
const records = async (file) => (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
const command = (cmd) => ({ hooks: [{ type: 'command', command: cmd }] });

test('PostToolUseFailure runs for failed tools (and PostToolUse does not)', async (t) => {
  const root = await tmp(t);
  const log = path.join(root, 'failures.jsonl');
  const post = path.join(root, 'post.jsonl');
  const { config, requests } = await scriptedModel(t, [toolCall('c1', 'read_file', { path: 'missing.txt' }), { content: 'done' }]);
  const session = await createSession({ root, config, settings: settingsWith({
    PostToolUseFailure: [{ matcher: 'Read', ...command(recorder(log, JSON.stringify({ hookSpecificOutput: { additionalContext: 'Hint: list the directory first.' } }))) }],
    PostToolUse: [command(recorder(post))]
  }) });
  await runAgentTurn(session, 'read it');
  const [payload] = await records(log);
  assert.equal(payload.hook_event_name, 'PostToolUseFailure');
  assert.equal(payload.tool_name, 'Read');
  assert.match(payload.error, /missing\.txt|ENOENT|not found|does not exist/i);
  assert.match(requests[1].messages.find((m) => m.role === 'tool').content, /Hint: list the directory first/);
  assert.equal((await records(post)).length, 0);
  closeSession(session);
});

test('PostToolUseFailure can replace the error the model sees', async (t) => {
  const root = await tmp(t);
  const log = path.join(root, 'failures.jsonl');
  const { config, requests } = await scriptedModel(t, [toolCall('c1', 'read_file', { path: 'missing.txt' }), { content: 'done' }]);
  const session = await createSession({ root, config, settings: settingsWith({
    PostToolUseFailure: [{ matcher: 'Read', ...command(recorder(log, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUseFailure', updatedError: 'File not found. Try glob first.' } }))) }]
  }) });
  await runAgentTurn(session, 'read it');
  const content = requests[1].messages.find((m) => m.role === 'tool').content;
  assert.match(content, /File not found\. Try glob first\./);
  assert.doesNotMatch(content, /ENOENT/);
  closeSession(session);
});

test('PermissionRequest hooks approve or deny before the user is asked', async (t) => {
  const root = await tmp(t);
  const log = path.join(root, 'requests.jsonl');
  const { config, requests } = await scriptedModel(t, [
    toolCall('c1', 'run_command', { command: process.execPath, args: ['-e', 'console.log("allowed-ran")'] }),
    toolCall('c2', 'run_command', { command: process.execPath, args: ['-e', 'console.log("denied-ran")'] }),
    { content: 'done' }
  ]);
  const decide = nodeHook('let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{require("fs").appendFileSync(' + JSON.stringify(log) + ',d+"\\n");const p=JSON.parse(d);const allow=JSON.stringify(p.tool_input).includes("allowed-ran");console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PermissionRequest",decision:allow?{behavior:"allow"}:{behavior:"deny",message:"No denied-ran today."}}}))})');
  const session = await createSession({ root, config, settings: settingsWith({ PermissionRequest: [{ matcher: 'Bash', ...command(decide) }] }) });
  let asked = 0;
  await runAgentTurn(session, 'run things', { approval: async () => { asked++; return false; } });
  assert.equal(asked, 0, 'the user was never prompted');
  const tools = requests[2].messages.filter((m) => m.role === 'tool');
  assert.match(tools[0].content, /allowed-ran/);
  assert.match(tools[1].content, /No denied-ran today/);
  const [first] = await records(log);
  assert.equal(first.hook_event_name, 'PermissionRequest');
  assert.equal(first.tool_name, 'Bash');
  assert.ok(Array.isArray(first.permission_suggestions));
  closeSession(session);
});

test('Notification hooks fire when Oasis waits for permission', async (t) => {
  const root = await tmp(t);
  const log = path.join(root, 'notes.jsonl');
  const { config } = await scriptedModel(t, [toolCall('c1', 'run_command', { command: process.execPath, args: ['-e', '1'] }), { content: 'done' }]);
  const session = await createSession({ root, config, settings: settingsWith({ Notification: [{ matcher: 'permission_prompt', ...command(recorder(log)) }] }) });
  await runAgentTurn(session, 'run', { approval: async () => { await new Promise((resolve) => setTimeout(resolve, 400)); return false; } });
  let notes = [];
  for (let i = 0; i < 40 && !notes.length; i++) { notes = await records(log); if (!notes.length) await new Promise((resolve) => setTimeout(resolve, 50)); }
  assert.equal(notes[0].notification_type, 'permission_prompt');
  assert.match(notes[0].message, /permission to use Bash/);
  closeSession(session);
});

test('http hooks POST the payload, interpolate only allowed env vars, and can deny tools', async (t) => {
  const root = await tmp(t);
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ headers: req.headers, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Policy server says no.' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/hook';
  const { config, requests } = await scriptedModel(t, [toolCall('c1', 'write_file', { path: 'x.txt', content: 'x' }), { content: 'done' }]);
  const session = await createSession({ root, config, settings: settingsWith({ PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'http', url, headers: { authorization: 'Bearer $HOOK_TOKEN', 'x-leak': '${OTHER_SECRET}' }, allowedEnvVars: ['HOOK_TOKEN'] }] }] }) });
  await runAgentTurn(session, 'write', { env: { ...process.env, HOOK_TOKEN: 'tok123', OTHER_SECRET: 'nope' }, autoApprove: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.authorization, 'Bearer tok123');
  assert.equal(seen[0].headers['x-leak'], '');
  assert.equal(seen[0].body.hook_event_name, 'PreToolUse');
  assert.equal(seen[0].body.tool_input.path, 'x.txt');
  assert.match(requests[1].messages.find((m) => m.role === 'tool').content, /Policy server says no/);
  await assert.rejects(readFile(path.join(root, 'x.txt')));
  // A failing server is a non-blocking error.
  const down = await runHooks('Stop', {}, { hooks: { Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:1/x', timeout: 2 }] }] }, root });
  assert.equal(down.blocked, false);
  assert.match(down.messages[0], /Stop hook failed/);
  closeSession(session);
});

test('prompt hooks let the model judge a Stop and keep the agent working', async (t) => {
  const root = await tmp(t);
  const { config, requests } = await scriptedModel(t, [
    { content: 'All done, no tests needed.' },
    { content: '{"ok": false, "reason": "You did not run the tests."}' },
    { content: 'Ran the tests: all pass.' },
    { content: '{"ok": true}' }
  ]);
  const session = await createSession({ root, config, settings: settingsWith({ Stop: [{ hooks: [{ type: 'prompt', prompt: 'Check the agent ran tests before stopping. Payload: $ARGUMENTS' }] }] }) });
  const result = await runAgentTurn(session, 'fix it');
  assert.equal(result.text, 'Ran the tests: all pass.');
  assert.match(requests[1].messages[0].content, /Reply with only a JSON object/);
  assert.match(requests[1].messages[1].content, /Check the agent ran tests[\s\S]*All done, no tests needed/);
  assert.match(requests[2].messages.at(-1).content, /You did not run the tests/);
  assert.equal(requests.length, 4);
  closeSession(session);
});

test('PreCompact, PostCompact, and SessionStart(compact) hooks wrap compaction', async (t) => {
  const root = await tmp(t);
  const log = path.join(root, 'post.jsonl');
  const { config, requests } = await scriptedModel(t, [{ content: 'first answer' }, { content: 'SUMMARY TEXT' }]);
  const session = await createSession({ root, config, settings: settingsWith({
    PreCompact: [{ matcher: 'manual', ...command(nodeHook('console.log(JSON.stringify({hookSpecificOutput:{additionalContext:"the deploy checklist"}}))')) }],
    PostCompact: [command(recorder(log))],
    SessionStart: [{ matcher: 'compact', ...command(nodeHook('console.log("Remember: sprint S42")')) }]
  }) });
  await runAgentTurn(session, 'hello');
  const result = await compactHistoryIfNeeded(session, { force: true });
  assert.equal(result.compacted, true);
  assert.match(requests[1].messages[0].content, /PreCompact hook asked the summary to keep: the deploy checklist/);
  const [post] = await records(log);
  assert.equal(post.trigger, 'manual');
  assert.equal(post.compact_summary, 'SUMMARY TEXT');
  assert.match(session.messages[1].content, /SUMMARY TEXT[\s\S]*Remember: sprint S42/);
  closeSession(session);

  const blocking = await createSession({ root, config, settings: settingsWith({ PreCompact: [command(nodeHook('console.error("not now");process.exit(2)'))] }) });
  blocking.messages.push({ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' });
  const blocked = await compactHistoryIfNeeded(blocking, { force: true });
  assert.equal(blocked.blockedByHook, true);
  assert.match(blocked.reason, /not now/);
  closeSession(blocking);
});

test('SubagentStart adds context to the subagent and SubagentStop gets its type', async (t) => {
  const root = await tmp(t);
  const log = path.join(root, 'stop.jsonl');
  const startLog = path.join(root, 'start.jsonl');
  const { config, requests } = await scriptedModel(t, [
    toolCall('c1', 'task', { subagent_type: 'general-purpose', description: 'look around', prompt: 'Describe the repo.' }),
    { content: 'child report' },
    { content: 'parent done' }
  ]);
  const session = await createSession({ root, config, settings: settingsWith({
    SubagentStart: [{ matcher: 'general-purpose', ...command(recorder(startLog, 'Use tabs, not spaces.')) }],
    SubagentStop: [command(recorder(log))]
  }) });
  await runAgentTurn(session, 'delegate', { autoApprove: true });
  assert.match(requests[1].messages.at(-1).content, /Describe the repo\.[\s\S]*Context from SubagentStart hooks:\nUse tabs, not spaces\./);
  const [start] = await records(startLog);
  assert.equal(start.agent_type, 'general-purpose');
  assert.match(start.agent_id, /\S/);
  const [stop] = await records(log);
  assert.equal(stop.hook_event_name, 'SubagentStop');
  assert.equal(stop.agent_type, 'general-purpose');
  closeSession(session);
});

test('settings accept command, http, and prompt hooks and drop invalid ones', async (t) => {
  const root = await tmp(t);
  const cfg = await tmp(t);
  await mkdir(cfg, { recursive: true });
  await writeFile(path.join(cfg, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
    { type: 'command', command: 'echo hi' },
    { type: 'http', url: 'https://hooks.example.com/check', headers: { authorization: 'Bearer $T', bad: 5 }, allowedEnvVars: ['T', 'not valid'] },
    { type: 'prompt', prompt: 'Is this safe? $ARGUMENTS', model: 'small-model' },
    { type: 'http', url: 'file:///etc/passwd' },
    { type: 'prompt', prompt: '  ' },
    { type: 'mystery' }
  ] }] } }));
  const settings = await loadSettings(root, { env: { ...process.env, OASIS_CONFIG_DIR: cfg } });
  const hooks = settings.hooks.PreToolUse[0].hooks;
  assert.deepEqual(hooks.map((hook) => hook.type), ['command', 'http', 'prompt']);
  assert.deepEqual(hooks[1].headers, { authorization: 'Bearer $T' });
  assert.deepEqual(hooks[1].allowedEnvVars, ['T']);
  assert.equal(hooks[2].model, 'small-model');
  assert.equal(describeHook(hooks[1]), 'POST https://hooks.example.com/check');
  assert.match(describeHook(hooks[2]), /^prompt: Is this safe/);
});
