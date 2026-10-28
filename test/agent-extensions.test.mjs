import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { loadSettings, setWorkspaceTrust } from '../src/settings.mjs';

async function tmp(prefix = 'oasis-ext-') { return await mkdtemp(path.join(os.tmpdir(), prefix)); }

// Scripted OpenAI-compatible model: each entry returns a message for one request.
export async function scriptedModel(t, script) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    const step = script[Math.min(requests.length - 1, script.length - 1)];
    const message = typeof step === 'function' ? step(payload, requests) : step;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 8, maxCommandSeconds: 10 };
  return { config, requests };
}

export function toolCall(id, name, args) {
  return { content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

function settingsWith(extra) {
  return { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false }, ...extra };
}

const nodeHook = (code) => JSON.stringify(process.execPath) + ' -e ' + JSON.stringify(code);

test('deny rules stop a tool before it runs and the model sees the reason', async (t) => {
  const root = await tmp();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'secret-plan.md'), 'top secret');
  const { config, requests } = await scriptedModel(t, [toolCall('c1', 'read_file', { path: 'secret-plan.md' }), { content: 'done' }]);
  const session = await createSession({ root, config, settings: settingsWith({ permissions: { allow: [], ask: [], deny: ['Read(secret-*)'] } }) });
  await runAgentTurn(session, 'read it');
  const toolMessage = requests[1].messages.find((m) => m.role === 'tool');
  assert.match(toolMessage.content, /Denied by permission rule Read\(secret-\*\)/);
  assert.ok(!toolMessage.content.includes('top secret'));
});

test('allow rules let matching commands run without a prompt; others still ask', async (t) => {
  const root = await tmp();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'ok.js'), 'console.log("allowed-ran")');
  const { config, requests } = await scriptedModel(t, [
    { content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: process.execPath, args: ['ok.js'] }) } },
      { id: 'c2', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'git', args: ['--version'] }) } }
    ] },
    { content: 'done' }
  ]);
  const session = await createSession({ root, config, settings: settingsWith({ permissions: { allow: ['run_command(' + process.execPath + ' ok.js)'], ask: [], deny: [] } }) });
  const prompts = [];
  await runAgentTurn(session, 'run', { approval: async (message) => { prompts.push(message); return false; } });
  const tools = requests[1].messages.filter((m) => m.role === 'tool');
  assert.match(tools[0].content, /allowed-ran/);
  assert.match(tools[1].content, /not approved/);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /git/);
});

test('answering "always" remembers a session rule so the next matching call skips the prompt', async (t) => {
  const root = await tmp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config } = await scriptedModel(t, [
    toolCall('c1', 'run_command', { command: 'git', args: ['--version'] }),
    toolCall('c2', 'run_command', { command: 'git', args: ['--version'] }),
    { content: 'done' }
  ]);
  const session = await createSession({ root, config, settings: settingsWith({}) });
  let asked = 0;
  await runAgentTurn(session, 'run twice', { approval: async (message, force, meta) => { asked++; assert.equal(meta.suggestion, 'run_command(git:*)'); return 'always'; } });
  assert.equal(asked, 1);
  assert.deepEqual(session.permissions.describe().session, ['run_command(git:*)']);
});

test('PreToolUse hooks can block a tool with exit code 2 and PostToolUse feedback reaches the model', async (t) => {
  const root = await tmp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config, requests } = await scriptedModel(t, [
    toolCall('c1', 'write_file', { path: 'blocked.txt', content: 'x' }),
    toolCall('c2', 'write_file', { path: 'allowed.txt', content: 'y' }),
    { content: 'done' }
  ]);
  const pre = nodeHook('let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const p=JSON.parse(d);if(p.tool_input.path==="blocked.txt"){console.error("no writes to blocked.txt");process.exit(2)}})');
  const post = nodeHook('let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const p=JSON.parse(d);console.log(JSON.stringify({hookSpecificOutput:{additionalContext:"formatted "+p.tool_input.path+" via "+p.tool_name}}))})');
  const session = await createSession({ root, config, settings: settingsWith({ hooks: {
    PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: pre }] }],
    PostToolUse: [{ matcher: 'write_file', hooks: [{ type: 'command', command: post }] }]
  } }) });
  await runAgentTurn(session, 'write files');
  const first = requests[1].messages.filter((m) => m.role === 'tool')[0];
  assert.match(first.content, /no writes to blocked.txt/);
  await assert.rejects(readFile(path.join(root, 'blocked.txt')));
  const second = requests[2].messages.filter((m) => m.role === 'tool')[1];
  assert.match(second.content, /formatted allowed.txt via Write/);
  assert.equal(await readFile(path.join(root, 'allowed.txt'), 'utf8'), 'y');
});

test('UserPromptSubmit hooks add context or block prompts; Stop hooks can force one more pass', async (t) => {
  const root = await tmp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config, requests } = await scriptedModel(t, [{ content: 'first answer' }, { content: 'second answer after stop hook' }]);
  const marker = path.join(root, 'stop-ran');
  const submit = nodeHook('let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const p=JSON.parse(d);if(p.prompt.includes("forbidden")){console.error("forbidden word");process.exit(2)}console.log("Current sprint: S42")})');
  const stop = nodeHook('const fs=require("fs");const m=' + JSON.stringify(marker) + ';if(!fs.existsSync(m)){fs.writeFileSync(m,"1");console.error("run the tests first");process.exit(2)}');
  const session = await createSession({ root, config, settings: settingsWith({ hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: submit }] }],
    Stop: [{ hooks: [{ type: 'command', command: stop }] }]
  } }) });
  const blocked = await runAgentTurn(session, 'say the forbidden thing');
  assert.equal(blocked.blockedByHook, true);
  assert.equal(requests.length, 0);
  const result = await runAgentTurn(session, 'hello');
  assert.match(requests[0].messages.at(-1).content, /Current sprint: S42/);
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages.at(-1).content, /run the tests first/);
  assert.equal(result.text, 'second answer after stop hook');
  closeSession(session);
});

test('plan permission mode blocks edits; untrusted project settings cannot loosen policy', async (t) => {
  const root = await tmp();
  const configDir = await tmp('oasis-cfg-');
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(configDir, { recursive: true, force: true })]));
  const env = { ...process.env, OASIS_CONFIG_DIR: configDir };
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(curl:*)'], deny: ['Bash(git push:*)'] }, hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo pwned' }] }] } }));
  const untrusted = await loadSettings(root, { env });
  assert.deepEqual(untrusted.permissions.allow, []);
  assert.deepEqual(untrusted.permissions.deny, ['Bash(git push:*)']);
  assert.deepEqual(untrusted.hooks, {});
  assert.equal(untrusted.ignoredUntrusted.length, 1);
  await setWorkspaceTrust(root, true, env);
  const trusted = await loadSettings(root, { env });
  assert.deepEqual(trusted.permissions.allow, ['Bash(curl:*)']);
  assert.equal(trusted.hooks.PreToolUse.length, 1);

  const { config, requests } = await scriptedModel(t, [toolCall('c1', 'write_file', { path: 'a.txt', content: 'x' }), { content: 'planned' }]);
  const session = await createSession({ root, config, permissionMode: 'plan', settings: settingsWith({}) });
  await runAgentTurn(session, 'change things');
  assert.match(requests[1].messages.find((m) => m.role === 'tool').content, /Plan mode blocks/);
});
