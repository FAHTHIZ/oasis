import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { repairToolArguments, extractTextToolCalls, ToolArgumentsError } from '../src/tool-call-repair.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';

const names = new Set(['read_file', 'run_command', 'edit_file']);

test('strict JSON arguments pass through untouched', () => {
  assert.deepEqual(repairToolArguments('{"path":"a.js"}'), { args: { path: 'a.js' }, repaired: false });
  assert.deepEqual(repairToolArguments({ path: 'a.js' }), { args: { path: 'a.js' }, repaired: false });
  assert.deepEqual(repairToolArguments(''), { args: {}, repaired: false });
});

test('near-miss arguments from smaller models are repaired', () => {
  const cases = [
    ['{"path":"a.js",}', { path: 'a.js' }],
    ['```json\n{"path":"a.js"}\n```', { path: 'a.js' }],
    [JSON.stringify(JSON.stringify({ path: 'a.js' })), { path: 'a.js' }],
    ["{'path': 'a.js'}", { path: 'a.js' }],
    ['{"recursive": True, "limit": None}', { recursive: true, limit: null }],
    ['{"content": "line one\nline two"}', { content: 'line one\nline two' }],
    ['{"path": "a.js"', { path: 'a.js' }],
    ['Sure, here you go: {"path": "a.js"}', { path: 'a.js' }],
    ['{"items": [1, 2, 3,],}', { items: [1, 2, 3] }],
    ["{'quote': 'say \"hi\"'}", { quote: 'say "hi"' }]
  ];
  for (const [raw, expected] of cases) {
    const result = repairToolArguments(raw);
    assert.deepEqual(result.args, expected, raw);
    assert.equal(result.repaired, true, raw);
  }
});

test('repairs never change the meaning of string contents', () => {
  const { args } = repairToolArguments('{"code": "if (True) { return None, }",}');
  assert.equal(args.code, 'if (True) { return None, }');
});

test('unrecoverable arguments raise an actionable error', () => {
  assert.throws(() => repairToolArguments('[1,2]'), ToolArgumentsError);
  assert.throws(() => repairToolArguments('not json at all'), /Resend the call with a single JSON object/);
  assert.throws(() => repairToolArguments('{"path": "a.js'), ToolArgumentsError);
});

test('text tool calls are recognized only for available tools', () => {
  const hermes = extractTextToolCalls('Reading it now.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.js"}}\n</tool_call>', names);
  assert.deepEqual(hermes, { calls: [{ name: 'read_file', args: { path: 'a.js' } }], text: 'Reading it now.' });
  const llama = extractTextToolCalls('<function=run_command>{"command": "npm", "args": ["test"]}</function>', names);
  assert.deepEqual(llama.calls, [{ name: 'run_command', args: { command: 'npm', args: ['test'] } }]);
  const fenced = extractTextToolCalls('```json\n{"name": "read_file", "parameters": {"path": "b.js"}}\n```', names);
  assert.deepEqual(fenced.calls, [{ name: 'read_file', args: { path: 'b.js' } }]);
  const bare = extractTextToolCalls('{"name": "read_file", "arguments": "{\\"path\\": \\"c.js\\"}"}', names);
  assert.deepEqual(bare.calls, [{ name: 'read_file', args: { path: 'c.js' } }]);
  const multi = extractTextToolCalls('<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>\n<tool_call>{"name":"read_file","arguments":{"path":"b"}}</tool_call>', names);
  assert.equal(multi.calls.length, 2);
});

test('ordinary replies and unknown tools are left alone', () => {
  assert.equal(extractTextToolCalls('All done. The config is {"debug": true}.', names), null);
  assert.equal(extractTextToolCalls('<tool_call>{"name": "delete_everything", "arguments": {}}</tool_call>', names), null);
  assert.equal(extractTextToolCalls('```json\n{"name": "read_file", "version": 2}\n```\nand more', new Set()), null);
  assert.equal(extractTextToolCalls('```json\n[{"name": "read_file", "arguments": {}}, {"debug": true}]\n```', names), null);
  assert.equal(extractTextToolCalls('', names), null);
});

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.txt'), 'REPAIRED-READ');
  return root;
}

const readCall = (args) => ({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: args } }] });

test('agent turn recovers sloppy arguments and replays canonical JSON', async (t) => {
  const root = await workspace(t);
  const { config, requests } = await scriptedModel(t, [readCall('```json\n{"path": "a.txt",}\n```'), { content: 'done' }]);
  const session = await createSession({ root, config, permissionMode: 'bypassPermissions' });
  t.after(() => closeSession(session));
  const repairs = [];
  const result = await runAgentTurn(session, 'read a.txt', { approval: async () => true, onToolCallRepair: (r) => repairs.push(r) });
  assert.equal(result.text, 'done');
  const replay = requests[1].messages.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.equal(replay.tool_calls[0].function.arguments, '{"path":"a.txt"}');
  assert.match(requests[1].messages.find((m) => m.role === 'tool').content, /REPAIRED-READ/);
  assert.deepEqual(repairs, [{ textCalls: 0, repairedArguments: 1, invalidArguments: 0 }]);
});

test('agent turn answers unrecoverable arguments with a tool error instead of failing', async (t) => {
  const root = await workspace(t);
  const { config, requests } = await scriptedModel(t, [readCall('path = a.txt'), readCall('{"path":"a.txt"}'), { content: 'second try worked' }]);
  const session = await createSession({ root, config, permissionMode: 'bypassPermissions' });
  t.after(() => closeSession(session));
  const result = await runAgentTurn(session, 'read a.txt', { approval: async () => true });
  assert.equal(result.text, 'second try worked');
  const firstTool = requests[1].messages.filter((m) => m.role === 'tool')[0];
  assert.match(firstTool.content, /not valid JSON/);
  assert.equal(requests[1].messages.find((m) => m.role === 'assistant' && m.tool_calls).tool_calls[0].function.arguments, '{}');
  assert.match(requests[2].messages.filter((m) => m.role === 'tool').at(-1).content, /REPAIRED-READ/);
});

test('agent turn executes tool calls a model wrote as text', async (t) => {
  const root = await workspace(t);
  const { config, requests } = await scriptedModel(t, [
    { content: 'Let me look.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.txt"}}\n</tool_call>' },
    { content: 'It says REPAIRED-READ.' }
  ]);
  const session = await createSession({ root, config, permissionMode: 'bypassPermissions' });
  t.after(() => closeSession(session));
  const result = await runAgentTurn(session, 'read a.txt', { approval: async () => true });
  assert.equal(result.text, 'It says REPAIRED-READ.');
  const assistant = requests[1].messages.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.equal(assistant.content, 'Let me look.');
  assert.equal(assistant.tool_calls[0].function.name, 'read_file');
  assert.match(requests[1].messages.find((m) => m.role === 'tool').content, /REPAIRED-READ/);
});

test('call syntax that is shown or quoted is never executed', () => {
  const names = new Set(['read_file', 'run_command']);
  // An example inside an explanation.
  const example = 'To run the tests yourself, the agent would send:\n\n```json\n{"name": "run_command", "arguments": {"command": "npm", "args": ["test"]}}\n```\n\nThat call runs the whole suite. You can narrow it with a file path, and the output shows each failing assertion with its diff.';
  assert.equal(extractTextToolCalls(example, names), null);
  // Tag syntax quoted from a file inside a code fence.
  const quotedTag = 'The prompt template contains:\n```\n<tool_call>{"name": "run_command", "arguments": {"command": "rm", "args": ["-rf", "x"]}}</tool_call>\n```';
  assert.equal(extractTextToolCalls(quotedTag, names), null);
  const quotedLlama = '```text\n<function=run_command>{"command": "curl"}</function>\n```';
  assert.equal(extractTextToolCalls(quotedLlama, names), null);
  // A short lead-in plus one fenced call is still recovered.
  const lead = extractTextToolCalls('Reading it.\n```json\n{"name": "read_file", "arguments": {"path": "a.js"}}\n```', names);
  assert.equal(lead.calls[0].name, 'read_file');
});

test('a reply that opens with bare call objects runs them and keeps the comment', () => {
  const names = new Set(['write_file', 'read_file']);
  const reply = '{"name": "write_file", "arguments": {"path": "src/lib.mjs", "content": "export const x = 1;\\n"}}\n\nThis function will create the file.';
  const found = extractTextToolCalls(reply, names);
  assert.equal(found.calls.length, 1);
  assert.equal(found.calls[0].name, 'write_file');
  assert.equal(found.calls[0].args.path, 'src/lib.mjs');
  assert.equal(found.text, 'This function will create the file.');
  // Prose before the object, or an object that is not a call, is left alone.
  assert.equal(extractTextToolCalls('The config looks like {"name": "write_file", "arguments": {}} here.', names), null);
  assert.equal(extractTextToolCalls('{"debug": true}\n\nThat is the config.', names), null);
});

test('XML-attribute tool calls are recovered', () => {
  const names = new Set(['write_file']);
  const reply = "<tools>\n    <function name=\"write_file\" arguments='{\"path\": \"src/lib.mjs\", \"content\": \"export const x = 1;\\n\"}'>\n</tools>";
  const found = extractTextToolCalls(reply, names);
  assert.equal(found.calls.length, 1);
  assert.equal(found.calls[0].args.path, 'src/lib.mjs');
  assert.equal(found.text, '');
  assert.equal(extractTextToolCalls('```\n<function name="write_file" arguments=\'{}\'>\n```', names), null);
});

test('local servers get near-greedy sampling; hosted APIs keep their defaults', async () => {
  const { samplingTemperature } = await import('../src/agent.mjs');
  assert.deepEqual(samplingTemperature({ baseURL: 'http://127.0.0.1:8080/v1' }, {}), { temperature: 0.2 });
  assert.deepEqual(samplingTemperature({ baseURL: 'https://api.openai.com/v1' }, {}), {});
  assert.deepEqual(samplingTemperature({ baseURL: 'https://api.openai.com/v1', temperature: 0.7 }, {}), { temperature: 0.7 });
  assert.deepEqual(samplingTemperature({ baseURL: 'http://127.0.0.1:8080/v1' }, { OASIS_TEMPERATURE: '0' }), { temperature: 0 });
  assert.deepEqual(samplingTemperature({ baseURL: 'http://127.0.0.1:8080/v1' }, { OASIS_TEMPERATURE: 'hot' }), {});
});

test('several JSON call objects in one fence are all recovered', async () => {
  const { extractTextToolCalls } = await import('../src/tool-call-repair.mjs');
  const content = '```\n{"name": "read_file", "arguments": {"path": "a.mjs"}}\n{"name": "write_file", "arguments": {"path": "a.mjs", "content": "x"}}\n```';
  const out = extractTextToolCalls(content, new Set(['read_file', 'write_file']));
  assert.deepEqual(out.calls.map((c) => c.name), ['read_file', 'write_file']);
});

test('replies made of calls to tools that do not exist are reported by name', async () => {
  const { unknownTextToolCalls } = await import('../src/tool-call-repair.mjs');
  const names = new Set(['read_file', 'git_commit']);
  assert.deepEqual(unknownTextToolCalls('{"name": "git_init", "arguments": {}}\n{"name": "git_add", "arguments": {"paths": ["a"]}}', names), ['git_init', 'git_add']);
  assert.deepEqual(unknownTextToolCalls('```json\n{"name": "git_init", "arguments": {}}\n```', names), ['git_init']);
  assert.deepEqual(unknownTextToolCalls('The config is {"name": "x", "arguments": 1}.', names), []);
  assert.deepEqual(unknownTextToolCalls('{"name": "my-package", "version": "1.0.0"}', names), []);
});
