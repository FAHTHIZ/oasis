import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { runExecuteCode, MAX_NESTED_CALLS } from '../src/code-mode.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

test('execute_code chains tool calls in the sandbox and returns only the result', async () => {
  const seen = [];
  const out = await runExecuteCode({ code: 'const a = await tools.read_file({ path: "a" }); const b = await tool("read_file", { path: "b" }); log("got", a.content.length); return a.content + b.content;' }, {
    runTool: async (name, args) => { seen.push([name, args.path]); return { content: args.path.toUpperCase() }; }
  });
  assert.equal(out.result, 'AB');
  assert.equal(out.toolCalls, 2);
  assert.deepEqual(seen, [['read_file', 'a'], ['read_file', 'b']]);
  assert.deepEqual(out.logs, ['got 1']);
});

test('execute_code blocks recursion, imports and runaway loops of calls', async () => {
  await assert.rejects(() => runExecuteCode({ code: 'return await tools.execute_code({ code: "1" })' }, { runTool: async () => ({}) }), /cannot be called/);
  await assert.rejects(() => runExecuteCode({ code: 'import("fs")' }, { runTool: async () => ({}) }), /cannot import/);
  await assert.rejects(() => runExecuteCode({ code: 'for (let i = 0; i < 1000; i++) await tools.grep({}); return 1' }, { runTool: async () => ({ output: '' }) }), new RegExp('limit of ' + MAX_NESTED_CALLS));
  await assert.rejects(() => runExecuteCode({ code: 'return await tools.read_file({ path: "x" })' }, { runTool: async () => ({ error: 'ENOENT' }) }), /read_file: ENOENT/);
});

test('the agent exposes execute_code and nested calls use the normal tool path and permissions', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-code-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'one.js'), '// TODO one\n');
  await writeFile(path.join(root, 'src', 'two.js'), 'ok\n// TODO two\n');
  const code = 'const files = await tools.glob_files({ pattern: "src/*.js" }); const list = files.files || files.matches || []; const out = []; for (const f of list) { const r = await tools.read_file({ path: typeof f === "string" ? f : f.path }); out.push(String(r.content || "").includes("TODO")); } const denied = await tools.run_command({ command: "node", args: ["-e", "1"] }).catch((e) => "blocked: " + e.message); return { count: out.filter(Boolean).length, denied };';
  const { config, requests } = await scriptedModel(t, [toolCall('c1', 'execute_code', { code }), { content: 'Both files have TODOs.' }]);
  const session = await createSession({ root, config: { ...config, maxSteps: 4 }, env: { ...process.env, OASIS_SANDBOX: '0' } });
  assert.ok((session.toolDefinitions.some((tool) => tool.function.name === 'execute_code') || session.deferredTools.has('execute_code')));
  let asked = 0;
  const result = await runAgentTurn(session, 'count TODO files', { approval: async () => { asked++; return false; } });
  assert.match(result.text, /TODOs/);
  const toolMessage = requests[1].messages.find((message) => message.role === 'tool');
  const payload = JSON.parse(toolMessage.content);
  assert.equal(payload.result.count, 2, toolMessage.content);
  assert.match(JSON.stringify(payload.result.denied), /not approved|blocked/);
  assert.ok(asked >= 1, 'run_command inside execute_code still asks for approval');
  assert.ok(!toolMessage.content.includes('TODO one'), 'intermediate file contents stay out of the context');
});
