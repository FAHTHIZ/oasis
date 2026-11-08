import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { normalizeAgentDefinition, loadAgentMemory, agentMemoryDirectory } from '../src/subagents.mjs';

test('front matter normalizes Claude Code subagent fields', () => {
  const agent = normalizeAgentDefinition({
    description: 'd', tools: 'Read, Grep, Bash', disallowedTools: 'Bash', maxTurns: '12', permissionMode: 'plan',
    skills: ['lint-rules', 'bad name'], memory: 'Project', background: 'true', color: 'Blue', effort: 'HIGH', model: 'inherit'
  }, ' body ', { name: 'x', source: 'project' });
  assert.deepEqual(agent.disallowedTools, ['run_command', 'run_shell', 'command_output', 'kill_command', 'list_background']);
  assert.equal(agent.maxTurns, 12);
  assert.equal(agent.permissionMode, 'plan');
  assert.deepEqual(agent.skills, ['lint-rules']);
  assert.equal(agent.memory, 'project');
  assert.equal(agent.background, true);
  assert.equal(agent.color, 'blue');
  assert.equal(agent.effort, 'high');
  assert.equal(agent.model, null);
  assert.equal(agent.prompt, 'body');
});

test('plugin agents cannot set a permission mode and loosening modes are ignored', () => {
  assert.equal(normalizeAgentDefinition({ permissionMode: 'plan' }, '', { name: 'p:x', source: 'plugin', plugin: true }).permissionMode, null);
  assert.equal(normalizeAgentDefinition({ permissionMode: 'bypassPermissions' }, '', { name: 'x', source: 'project' }).permissionMode, null);
});

test('agent memory reads the first 200 lines of MEMORY.md for the chosen scope', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-agentmem-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agent = { name: 'reviewer', memory: 'project' };
  const dir = agentMemoryDirectory(agent, root, {});
  assert.equal(dir, path.join(root, '.claude', 'agent-memory', 'reviewer'));
  assert.equal(await loadAgentMemory(agent, root, {}), '');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'MEMORY.md'), Array.from({ length: 300 }, (_, i) => 'line ' + i).join('\n'));
  const text = await loadAgentMemory(agent, root, {});
  assert.equal(text.split('\n').length, 200);
  assert.equal(agentMemoryDirectory({ name: 'r', memory: 'local' }, root, {}), path.join(root, '.claude', 'agent-memory-local', 'r'));
  assert.equal(agentMemoryDirectory({ name: 'r', memory: 'user' }, root, { HOME: '/h' }), path.join('/h', '.claude', 'agent-memory', 'r'));
});

async function harness(t, { definition, taskArgs, childReplies, files = {}, inline = null, type = 'scout' }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-subdef-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.oasis', 'agents'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'agents', 'scout.md'), '---\nname: scout\ndescription: Finds files\n' + definition + '---\nYou find files.\n');
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text);
  const payloads = [];
  let childCalls = 0;
  let taskResult = null;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    payloads.push(payload);
    const isChild = /You find files/.test(payload.messages[0].content);
    const toolMessage = payload.messages.find((message) => message.role === 'tool');
    let message;
    if (isChild) message = { role: 'assistant', content: childReplies[Math.min(childCalls++, childReplies.length - 1)] };
    else if (toolMessage) { taskResult = toolMessage.content; message = { role: 'assistant', content: 'all done' }; }
    else message = { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'task', arguments: JSON.stringify({ description: 'find', prompt: 'find the config', subagent_type: type, ...taskArgs }) } }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...process.env, OASIS_SUBAGENT_EFFORT: '', CLAUDE_CODE_SUBAGENT_EFFORT: '' };
  const session = await createSession({ root, env, agentsInline: inline, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 } });
  await runAgentTurn(session, 'go', { autoApprove: true, env });
  const children = payloads.filter((payload) => /You find files/.test(payload.messages[0].content));
  return { children, taskResult, root };
}

test('disallowedTools removes tools from the child and memory is injected', async (t) => {
  const { children } = await harness(t, { definition: 'disallowedTools: Bash, Write\nmemory: project\n', taskArgs: {}, childReplies: ['found it'] });
  const names = (children[0].tools || []).map((tool) => tool.function.name);
  assert.ok(names.includes('read_file'));
  assert.ok(!names.includes('run_command'));
  assert.ok(!names.includes('write_file'));
  assert.match(children[0].messages[0].content, /AGENT MEMORY \(project scope/);
});

test('output_schema validates the report and allows one correction turn', async (t) => {
  const schema = { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] };
  const { children, taskResult } = await harness(t, { definition: '', taskArgs: { output_schema: schema }, childReplies: ['I found config.json', '{"files":["config.json"]}'] });
  assert.equal(children.length, 2);
  assert.match(children[1].messages.at(-1).content, /does not match the required output schema/);
  const result = JSON.parse(taskResult);
  assert.deepEqual(result.structured, { files: ['config.json'] });
});

test('output_schema reports schema_errors when the correction still fails', async (t) => {
  const schema = { type: 'object', required: ['files'] };
  const { taskResult } = await harness(t, { definition: '', taskArgs: { output_schema: schema }, childReplies: ['nope', 'still nope'] });
  const result = JSON.parse(taskResult);
  assert.ok(Array.isArray(result.schema_errors) && result.schema_errors.length);
});

test('a background agent with no activity is stopped as stalled', async (t) => {
  const { getAgent, listAgents } = await import('../src/agent-tasks.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-stall-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hanging = new Set();
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    if (/SUBAGENT MODE/.test(payload.messages[0].content)) { hanging.add(res); return; }
    const done = payload.messages.some((message) => message.role === 'tool');
    const message = done ? { role: 'assistant', content: 'started' }
      : { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'task', arguments: JSON.stringify({ description: 'slow', prompt: 'wait', run_in_background: true }) } }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const res of hanging) res.destroy(); server.close(); });
  const env = { ...process.env, OASIS_SUBAGENT_STALL_SECONDS: '1' };
  const session = await createSession({ root, env, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 } });
  await runAgentTurn(session, 'go', { autoApprove: true, env });
  const [summary] = listAgents(session);
  const record = getAgent(session, summary.id);
  await record.promise;
  assert.equal(record.status, 'stalled');
  assert.match(record.error, /No activity for \d+s/);
});

test('agent hooks merge with the parent hooks; Stop becomes SubagentStop; untrusted project files add none', async () => {
  const { agentScopedHooks } = await import('../src/subagent-support.mjs');
  const parentHooks = { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'parent' }] }] };
  const hooks = { Stop: [{ hooks: [{ type: 'command', command: 'check-report' }] }], PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'lint' }] }] };
  const agent = normalizeAgentDefinition({ hooks }, '', { name: 'r', source: 'user:/x' });
  const merged = agentScopedHooks({ hooks: parentHooks, settings: {} }, agent);
  assert.equal(merged.PreToolUse.length, 2);
  assert.equal(merged.SubagentStop[0].hooks[0].command, 'check-report');
  assert.ok(!merged.Stop);
  assert.equal(parentHooks.PreToolUse.length, 1, 'the parent hooks are not mutated');
  const project = normalizeAgentDefinition({ hooks }, '', { name: 'r', source: 'project:/x' });
  assert.equal(agentScopedHooks({ hooks: parentHooks, settings: { trusted: false } }, project), parentHooks);
  assert.equal(agentScopedHooks({ hooks: parentHooks, settings: { trusted: true } }, project).PreToolUse.length, 2);
  assert.equal(normalizeAgentDefinition({ hooks }, '', { name: 'p:r', source: 'plugin:p', plugin: true }).hooks, null);
});

test('omitClaudeMd starts the agent without project instructions', async (t) => {
  const marker = 'PROJECT-RULE-7Q';
  const run = async (definition) => {
    const result = await harness(t, { definition, taskArgs: {}, childReplies: ['ok'], files: { 'OASIS.md': '# Rules\n' + marker + '\n' } });
    return result.children[0].messages[0].content;
  };
  assert.match(await run(''), new RegExp(marker));
  const omitted = await run('omitClaudeMd: true\n');
  assert.doesNotMatch(omitted, new RegExp(marker));
  assert.match(omitted, /Project instruction files are omitted for this agent/);
  assert.match(omitted, /You find files/);
});

test('a Stop hook in an agent definition runs as SubagentStop and sends the agent back', async (t) => {
  const { children } = await harness(t, { definition: '', taskArgs: {}, childReplies: ['first', 'second'], inline: { scout2: { description: 'x', prompt: 'You find files.', hooks: { Stop: [{ hooks: [{ type: 'command', command: process.execPath + ' -e "process.stderr.write(\'add the summary\');process.exit(2)"' }] }] } } }, type: 'scout2' });
  assert.ok(children.length >= 2);
  assert.match(children[1].messages.at(-1).content, /SubagentStop hook asked you to continue/);
});

test('--agent applies initialPrompt to the first turn and honours disallowedTools', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-mainagent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.oasis', 'agents'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'agents', 'triage.md'), '---\nname: triage\ndescription: Triage\ndisallowedTools: Bash\ninitialPrompt: Read the open TODO list first.\n---\nYou triage.\n');
  const payloads = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    payloads.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 2 };
  const session = await createSession({ root, config, agent: 'triage' });
  await runAgentTurn(session, 'and then fix bug 12');
  await runAgentTurn(session, 'second turn');
  const firstUser = payloads[0].messages.filter((message) => message.role === 'user').map((message) => String(message.content)).join('\n');
  assert.match(firstUser, /Read the open TODO list first\.\s+and then fix bug 12/);
  const secondUsers = payloads[1].messages.filter((message) => message.role === 'user').map((message) => String(message.content));
  assert.equal(secondUsers.filter((text) => /Read the open TODO list first/.test(text)).length, 1, 'only the first turn gets it');
  const names = (payloads[0].tools || []).map((tool) => tool.function.name);
  assert.ok(!names.includes('run_command') && !names.includes('run_shell'));
  const skipped = await createSession({ root, config, agent: 'triage', skipAgentInitialPrompt: true });
  assert.equal(skipped.agentInitialPrompt, undefined);
});
