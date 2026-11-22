import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createSession, runAgentTurn, sessionRestoreSnapshot } from '../src/agent.mjs';
import { BUILTIN_AGENTS, taskToolDefinition } from '../src/subagents.mjs';
import { defineSessionAgent, sanitizeDefinedAgents, applyDefinedAgents, SESSION_AGENT_SOURCE } from '../src/session-agents.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

function bareSession() {
  return {
    agents: { ...BUILTIN_AGENTS, mine: { name: 'mine', source: '/p/.oasis/agents/mine.md', description: 'file agent' } },
    toolDefinitions: [{ type: 'function', function: { name: 'read_file' } }, { type: 'function', function: { name: 'grep' } }, taskToolDefinition(BUILTIN_AGENTS)],
    deferredTools: new Map([['fetch_url', { type: 'function', function: { name: 'fetch_url' } }]])
  };
}

test('agent_define validates the definition and updates the task tool', () => {
  const session = bareSession();
  const result = defineSessionAgent(session, { name: 'API-Reviewer', description: 'Review API changes for compatibility', instructions: 'Check every exported function.', tools: ['read_file', 'grep', 'fetch_url'], domains: ['code'], max_turns: 900, hooks: { PreToolUse: [] }, mcpServers: { x: { command: 'sh' } } });
  assert.equal(result.defined, 'api-reviewer');
  const agent = session.agents['api-reviewer'];
  assert.equal(agent.source, SESSION_AGENT_SOURCE);
  assert.ok(['read_file', 'grep', 'fetch_url'].every((tool) => agent.tools.includes(tool)));
  assert.ok(!agent.tools.includes('run_command'));
  assert.equal(agent.maxTurns, 400);
  assert.deepEqual(agent.domains, ['code']);
  assert.equal(agent.hooks, null, 'no hooks from a defined agent');
  assert.equal(agent.mcpServers, null, 'no MCP servers from a defined agent');
  assert.match(agent.prompt, /Check every exported function/);
  const task = session.toolDefinitions.find((tool) => tool.function.name === 'task');
  assert.ok(task.function.parameters.properties.subagent_type.enum.includes('api-reviewer'));

  assert.throws(() => defineSessionAgent(session, { name: 'explore', description: 'x', instructions: 'y' }), /already exists \(built-in\)/);
  assert.throws(() => defineSessionAgent(session, { name: 'mine', description: 'x', instructions: 'y' }), /cannot be replaced/);
  assert.throws(() => defineSessionAgent(session, { name: 'a', description: 'x', instructions: 'y' }), /needs a name/);
  assert.throws(() => defineSessionAgent(session, { name: 'tester', instructions: 'y' }), /needs a description/);
  assert.throws(() => defineSessionAgent(session, { name: 'tester', description: 'x', instructions: 'y', tools: ['rm_rf'] }), /Unknown tool rm_rf/);
  assert.throws(() => defineSessionAgent(session, { name: 'tester', description: 'x', instructions: 'y', model: 'gpt-x' }, { modelAllowed: () => false }), /not allowed by this session's model policy/);
  assert.equal(defineSessionAgent(session, { name: 'api-reviewer', description: 'Review APIs', instructions: 'Changed.' }).replaced, true);
  assert.equal(session.agents['api-reviewer'].tools, null, 'a redefinition replaces the old one');
  assert.deepEqual(defineSessionAgent(session, { name: 'api-reviewer', remove: true }), { removed: 'api-reviewer' });
  assert.equal(session.agents['api-reviewer'], undefined);
  assert.ok(!session.toolDefinitions.find((tool) => tool.function.name === 'task').function.parameters.properties.subagent_type.enum.includes('api-reviewer'));
});

test('saved definitions are cleaned and restored without replacing other agents', () => {
  const saved = sanitizeDefinedAgents({ good: { description: 'd', instructions: 'i', tools: ['read_file', '$(x)'], hooks: {} }, explore: { description: 'd', instructions: 'i' }, 'Bad Name': { description: 'd', instructions: 'i' }, empty: { description: 'd' } });
  assert.deepEqual(Object.keys(saved), ['good']);
  assert.deepEqual(saved.good, { description: 'd', instructions: 'i', tools: ['read_file'] });
  const session = { ...bareSession(), definedAgents: { ...saved, mine: { description: 'd', instructions: 'i' } } };
  applyDefinedAgents(session);
  assert.equal(session.agents.good.source, SESSION_AGENT_SOURCE);
  assert.equal(session.agents.mine.source, '/p/.oasis/agents/mine.md');
});

test('the main agent defines a specialist and runs it; it is saved with the session', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-define-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const childRequests = [];
  const { config } = await scriptedModel(t, [(payload) => {
    if (payload.messages[0].content.includes('SUBAGENT MODE')) { childRequests.push(payload); return { content: 'Reviewed: no breaking changes.' }; }
    const tools = payload.messages.filter((message) => message.role === 'tool').length;
    if (tools === 0) return toolCall('d1', 'agent_define', { name: 'api-reviewer', description: 'Review API changes', instructions: 'You are an API compatibility reviewer. Quote each exported signature.', tools: ['read_file', 'grep'] });
    if (tools === 1) return toolCall('t1', 'task', { description: 'review api', prompt: 'Review the API of this repo.', subagent_type: 'api-reviewer' });
    return { content: 'done' };
  }]);
  const env = { ...process.env, OASIS_AGENT_EXPERIENCE: '0', OASIS_NEURON_LEDGER: '0' };
  const session = await createSession({ root, env, config });
  await runAgentTurn(session, 'review the api', { autoApprove: true, env });
  assert.equal(childRequests.length, 1);
  assert.match(childRequests[0].messages[0].content, /API compatibility reviewer/);
  const childTools = childRequests[0].tools.map((tool) => tool.function.name);
  assert.ok(childTools.includes('read_file') && childTools.includes('grep'));
  assert.ok(!childTools.includes('run_command') && !childTools.includes('edit_file'), 'the tool list is narrowed');
  assert.ok(!childTools.includes('agent_define'), 'subagents cannot define agents');
  const snapshot = sessionRestoreSnapshot(session);
  assert.equal(snapshot.definedAgents['api-reviewer'].instructions, 'You are an API compatibility reviewer. Quote each exported signature.');
  const restored = await createSession({ root, env, config, restore: snapshot });
  assert.equal(restored.agents['api-reviewer'].source, SESSION_AGENT_SOURCE);
  assert.ok(restored.toolDefinitions.find((tool) => tool.function.name === 'task').function.parameters.properties.subagent_type.enum.includes('api-reviewer'));
});

test('an agent file written during the session is picked up by task', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-define-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const childRequests = [];
  const { config } = await scriptedModel(t, [(payload) => {
    if (payload.messages[0].content.includes('SUBAGENT MODE')) { childRequests.push(payload); return { content: 'ok' }; }
    return payload.messages.some((message) => message.role === 'tool') ? { content: 'done' } : toolCall('t1', 'task', { description: 'check', prompt: 'Check it.', subagent_type: 'late-checker' });
  }]);
  const env = { ...process.env, OASIS_AGENT_EXPERIENCE: '0', OASIS_NEURON_LEDGER: '0' };
  const session = await createSession({ root, env, config });
  await mkdir(path.join(root, '.oasis', 'agents'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'agents', 'late-checker.md'), '---\nname: late-checker\ndescription: Checks late things\n---\nYou are the late checker.\n');
  await runAgentTurn(session, 'check', { autoApprove: true, env });
  assert.equal(childRequests.length, 1);
  assert.match(childRequests[0].messages[0].content, /You are the late checker/);
});
