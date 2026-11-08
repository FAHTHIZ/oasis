// Prompt-mode tool calling for endpoints that drop `tools` (or system messages).
import test from 'node:test';
import assert from 'node:assert/strict';
import { promptToolCalling, toPromptToolMessages, callAsText, describeTools, foldSystemMessages, withSystemInUserTurn } from '../src/prompt-tools.mjs';
import { extractTextToolCalls } from '../src/tool-call-repair.mjs';
import { formatApiError } from '../src/api-error.mjs';
import { isPromptTooLargeError } from '../src/provider-retry.mjs';

const tools = [
  { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' }, limit: { type: 'integer' }, mode: { type: 'string', enum: ['text', 'hex'] } }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_files', description: 'List files', parameters: { type: 'object', properties: {} } } }
];

test('prompt mode is opt-in by config or environment, and native wins when forced', () => {
  assert.equal(promptToolCalling({}, {}), false);
  assert.equal(promptToolCalling({ toolCalling: 'prompt' }, {}), true);
  assert.equal(promptToolCalling({}, { OASIS_TOOL_CALLING: 'prompt' }), true);
  assert.equal(promptToolCalling({ toolCalling: 'prompt' }, { OASIS_TOOL_CALLING: 'native' }), false);
  assert.equal(foldSystemMessages({ systemMessages: 'user' }, {}), true);
  assert.equal(foldSystemMessages({ systemMessages: 'user' }, { OASIS_SYSTEM_MESSAGES: 'system' }), false);
});

test('tool descriptions list parameters, required flags and allowed values', () => {
  const text = describeTools(tools);
  assert.match(text, /BEGIN FUNCTION #1: read_file/);
  assert.match(text, /path \(string, required\): File path/);
  assert.match(text, /limit \(integer, optional\)/);
  assert.match(text, /Allowed values: `text`, `hex`/);
  assert.match(text, /BEGIN FUNCTION #2: list_files ----\nDescription: List files\nNo parameters\./);
});

test('history is rewritten: calls become text, results become user turns, roles alternate', () => {
  const out = toPromptToolMessages([
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'fix it' },
    { role: 'assistant', content: 'Looking.', tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js","limit":5}' } }, { id: 'b', type: 'function', function: { name: 'list_files', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'x=1' },
    { role: 'tool', tool_call_id: 'b', content: 'a.js' }
  ], tools);
  assert.deepEqual(out.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.match(out[0].content, /^SYS\n[\s\S]*You have access to the following functions/);
  assert.equal(out[2].content, 'Looking.\n\n<function=read_file>\n<parameter=path>a.js</parameter>\n<parameter=limit>5</parameter>\n</function>\n\n<function=list_files>\n</function>');
  assert.equal(out[3].content, 'EXECUTION RESULT of [read_file]:\nx=1\n\nEXECUTION RESULT of [list_files]:\na.js');
  assert.ok(out.every((m) => !m.tool_calls && m.role !== 'tool'));
});

test('multi-line string values keep their newlines; objects are JSON', () => {
  assert.equal(callAsText({ function: { name: 'write_file', arguments: JSON.stringify({ path: 'a', content: 'one\ntwo', meta: { x: 1 } }) } }),
    '<function=write_file>\n<parameter=path>a</parameter>\n<parameter=content>\none\ntwo\n</parameter>\n<parameter=meta>{"x":1}</parameter>\n</function>');
});

test('what the model writes back parses into typed calls, including calls with no parameters', () => {
  const schemas = new Map(tools.map((tool) => [tool.function.name, tool.function.parameters]));
  const parsed = extractTextToolCalls('Reading.\n<function=read_file>\n<parameter=path>a.js</parameter>\n<parameter=limit>5</parameter>\n</function>\n<function=list_files>\n</function>', new Set(['read_file', 'list_files']), schemas);
  assert.deepEqual(parsed.calls, [{ name: 'read_file', args: { path: 'a.js', limit: 5 } }, { name: 'list_files', args: {} }]);
  assert.equal(parsed.text, 'Reading.');
});

test('system messages can travel inside the first user turn', () => {
  const out = withSystemInUserTurn([{ role: 'system', content: 'RULES' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }, { role: 'system', content: 'NOTE' }]);
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(out[0].content, '<system_instructions>\nRULES\n</system_instructions>\n\nhi');
  assert.equal(out[2].content, '<system_reminder>\nNOTE\n</system_reminder>');
});

test('an agent turn in prompt mode sends no tools, runs the written call and finishes', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { scriptedModel } = await import('./helpers/scripted-model.mjs');
  const { createSession, runAgentTurn, closeSession } = await import('../src/agent.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-prompt-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.txt'), 'alpha\n');
  const { config, requests } = await scriptedModel(t, [
    { content: 'I will read it.\n<function=read_file>\n<parameter=path>a.txt</parameter>\n</function>' },
    (payload) => ({ content: payload.messages.at(-1).content.includes('alpha') ? 'It says alpha.' : 'no result' })
  ]);
  const session = await createSession({ root, config: { ...config, toolCalling: 'prompt', systemMessages: 'user' }, env: { ...process.env, HOME: root, OASIS_CONFIG_DIR: path.join(root, '.cfg') } });
  t.after(() => closeSession(session));
  const result = await runAgentTurn(session, 'what is in a.txt?', { autoApprove: true });
  assert.match(String(result.content || result.text || result), /alpha/);
  for (const payload of requests) {
    assert.equal(payload.tools, undefined);
    assert.ok(payload.messages.every((m) => m.role === 'user' || m.role === 'assistant'), 'no system or tool roles');
  }
  assert.match(requests[0].messages[0].content, /^<system_instructions>[\s\S]*BEGIN FUNCTION #\d+: read_file/);
  assert.match(requests[1].messages.at(-1).content, /^EXECUTION RESULT of \[read_file\]:[\s\S]*alpha/);
});

test('a prompt that is too large is reported as such and not retried as a server fault', () => {
  const body = JSON.stringify({ error: { message: 'Stream ended before producing a non-ping SSE event', type: 'stream_early_eof' }, upstream_details: { error: { message: 'Prompt too long (max 6000 characters).' } } });
  assert.equal(isPromptTooLargeError(body), true);
  const message = formatApiError(502, body, 'openai-compatible');
  assert.match(message, /upstream: Prompt too long \(max 6000 characters\)/);
  assert.match(message, /retrying will not help/);
  assert.doesNotMatch(message, /server-side problem/);
});
