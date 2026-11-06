import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { planPatch, patchFromToolCall, patchFilesNeeded, PatchError } from '../src/apply-patch.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';

const SRC = 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n';
const patch = (body) => '*** Begin Patch\n' + body + '\n*** End Patch';

test('planPatch: update with an @@ anchor, add, delete and move', () => {
  const plan = planPatch(patch('*** Update File: x.js\n@@ function b() {\n-  return 2;\n+  return 3;\n*** Add File: new/y.js\n+hello\n+world\n*** Delete File: old.txt\n*** Update File: m.js\n*** Move to: moved/m.js\n@@\n-one\n+uno'), { 'x.js': SRC, 'old.txt': 'bye\n', 'm.js': 'one\n' });
  assert.deepEqual(plan.operations, [
    { type: 'update', path: 'x.js', content: SRC.replace('return 2', 'return 3') },
    { type: 'add', path: 'new/y.js', content: 'hello\nworld\n' },
    { type: 'delete', path: 'old.txt' },
    { type: 'update', path: 'm.js', content: 'uno\n', moveTo: 'moved/m.js' }
  ]);
  assert.equal(plan.fuzz, 0);
});

test('planPatch: the @@ anchor picks the right one of two identical lines', () => {
  const plan = planPatch(patch('*** Update File: x.js\n@@ function b() {\n-  return\n+  return 0'), { 'x.js': 'function a() {\n  return\n}\nfunction b() {\n  return\n}\n' });
  assert.equal(plan.operations[0].content, 'function a() {\n  return\n}\nfunction b() {\n  return 0\n}\n');
});

test('planPatch: CRLF and BOM files match LF patches; whitespace drift is fuzz, not failure', () => {
  const crlf = planPatch(patch('*** Update File: w.txt\n@@\n line one\n-line two\n+LINE TWO'), { 'w.txt': '\ufeffline one\r\nline two\r\n' });
  assert.equal(crlf.operations[0].content, 'line one\nLINE TWO\n');
  const drift = planPatch(patch('*** Update File: x.js\n@@\n function b() {   \n-  return 2;\n+  return 3;'), { 'x.js': SRC });
  assert.equal(drift.operations[0].content, SRC.replace('return 2', 'return 3'));
  assert.ok(drift.fuzz > 0);
});

test('planPatch: End of File anchors to the last lines', () => {
  const plan = planPatch(patch('*** Update File: f.txt\n@@\n-x\n+y\n*** End of File'), { 'f.txt': 'x\nmid\nx' });
  assert.equal(plan.operations[0].content, 'x\nmid\ny');
});

test('planPatch rejects bad patches before anything is written', () => {
  assert.throws(() => planPatch('no markers', {}), PatchError);
  assert.throws(() => planPatch(patch('*** Update File: x.js\n@@\n-  return 99;\n+  return 3;'), { 'x.js': SRC }), /Could not find these lines in x\.js/);
  assert.throws(() => planPatch(patch('*** Update File: gone.js\n@@\n-a\n+b'), {}), /does not exist/);
  assert.throws(() => planPatch(patch('*** Delete File: gone.js'), {}), /does not exist/);
  assert.throws(() => planPatch(patch('*** Add File: a.txt\nnot-plus'), {}), /must start with "\+"/);
  assert.throws(() => planPatch(patch('*** Update File: x.js\n@@\n-a\n+b\n*** Update File: x.js\n@@\n-c\n+d'), { 'x.js': 'a\nc\n' }), /twice/);
  assert.throws(() => planPatch('*** Begin Patch\n*** Add File: a.txt\n+x\n', {}), /missing|must start/i);
  assert.throws(() => planPatch(patch('garbage line'), {}), /Unknown line/);
});

test('patchFromToolCall recognizes the shapes GPT/Codex models emit and nothing else', () => {
  const body = patch('*** Add File: a.txt\n+x');
  assert.equal(patchFromToolCall('apply_patch', JSON.stringify({ patch: body }), { patch: body }), body);
  assert.equal(patchFromToolCall('apply_patch', JSON.stringify({ input: body }), { input: body }), body);
  assert.equal(patchFromToolCall('apply_patch', body, {}), body, 'freeform tool: raw patch as arguments');
  assert.equal(patchFromToolCall('ApplyPatch', body, {}), body);
  assert.equal(patchFromToolCall('run_shell', '', { command: "apply_patch <<'EOF'\n" + body + "\nEOF" }), body);
  assert.equal(patchFromToolCall('run_command', '', { command: 'apply_patch', args: [body] }), body);
  assert.equal(patchFromToolCall('shell', '', { command: ['bash', '-lc', "apply_patch <<'EOF'\n" + body + "\nEOF"] }), body);
  // A script that only mentions apply_patch, or other tools carrying patch text, are left alone.
  assert.equal(patchFromToolCall('run_shell', '', { command: "echo apply_patch && cat <<'EOF'\n" + body + '\nEOF' }), null);
  assert.equal(patchFromToolCall('run_shell', '', { command: 'grep -r apply_patch src' }), null);
  assert.equal(patchFromToolCall('write_file', '', { path: 'p.diff', content: body }), null);
  assert.deepEqual(patchFilesNeeded(patch('*** Update File: a\n@@\n-x\n+y\n*** Delete File: b\n*** Add File: c\n+z')).sort(), ['a', 'b']);
});

async function fixture(t, script, { permissionMode = 'bypassPermissions', files = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-apply-patch-'));
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text);
  const { config, requests } = await scriptedModel(t, script);
  const session = await createSession({ root, config, permissionMode, env: { ...process.env, HOME: root, OASIS_CONFIG_DIR: root } });
  t.after(async () => { closeSession(session); await rm(root, { recursive: true, force: true }); });
  return { root, session, requests };
}

const toolResults = (requests) => requests.flatMap((payload) => payload.messages.filter((m) => m.role === 'tool'));

test('an apply_patch call from the model edits files through write_file and declares the tool afterwards', async (t) => {
  const body = patch('*** Update File: x.js\n@@ function b() {\n-  return 2;\n+  return 3;\n*** Add File: y.js\n+const y = 1;');
  const { root, session, requests } = await fixture(t, [toolCall('p1', 'apply_patch', { patch: body }), { content: 'Done.' }], { files: { 'x.js': SRC } });
  const result = await runAgentTurn(session, 'change b to return 3', {});
  assert.equal(result.text, 'Done.');
  assert.equal(await readFile(path.join(root, 'x.js'), 'utf8'), SRC.replace('return 2', 'return 3'));
  assert.equal(await readFile(path.join(root, 'y.js'), 'utf8'), 'const y = 1;\n');
  const [message] = toolResults(requests);
  assert.match(message.content, /Success\. Updated the following files:\\nM x\.js\\nA y\.js/);
  assert.ok(!requests[0].tools.some((tool) => tool.function.name === 'apply_patch'), 'not advertised up front (no schema cost)');
  assert.ok(requests[1].tools.some((tool) => tool.function.name === 'apply_patch'), 'declared once used, so the history names a real tool');
});

test('a freeform apply_patch (raw text arguments) and a shell heredoc both apply', async (t) => {
  const freeform = patch('*** Update File: x.js\n@@\n-  return 1;\n+  return 10;');
  const heredoc = "apply_patch <<'EOF'\n" + patch('*** Update File: x.js\n@@\n-  return 10;\n+  return 11;') + '\nEOF';
  const { root, session, requests } = await fixture(t, [
    { content: null, tool_calls: [{ id: 'f1', type: 'function', function: { name: 'apply_patch', arguments: freeform } }] },
    toolCall('s1', 'run_shell', { command: heredoc }),
    { content: 'Done.' }
  ], { files: { 'x.js': SRC } });
  await runAgentTurn(session, 'edit', {});
  assert.equal(await readFile(path.join(root, 'x.js'), 'utf8'), SRC.replace('return 1', 'return 11'));
  const assistantCall = requests[1].messages.find((m) => m.role === 'assistant' && m.tool_calls).tool_calls[0];
  assert.equal(assistantCall.function.name, 'apply_patch');
  assert.deepEqual(JSON.parse(assistantCall.function.arguments), { patch: freeform }, 'freeform text is stored as JSON input');
});

test('a patch with one bad hunk changes nothing and tells the model what did not match', async (t) => {
  const body = patch('*** Add File: y.js\n+new\n*** Update File: x.js\n@@\n-  return 99;\n+  return 3;');
  const { root, session, requests } = await fixture(t, [toolCall('p1', 'apply_patch', { patch: body }), { content: 'Done.' }], { files: { 'x.js': SRC } });
  await runAgentTurn(session, 'edit', {});
  assert.equal(await readFile(path.join(root, 'x.js'), 'utf8'), SRC);
  await assert.rejects(access(path.join(root, 'y.js')), 'the valid Add section was not applied either');
  assert.match(toolResults(requests)[0].content, /nothing was changed.*Could not find these lines in x\.js/is);
});

test('plan mode blocks apply_patch like any other edit', async (t) => {
  const body = patch('*** Update File: x.js\n@@\n-  return 1;\n+  return 3;');
  const { root, session, requests } = await fixture(t, [toolCall('p1', 'apply_patch', { patch: body }), { content: 'Done.' }], { permissionMode: 'plan', files: { 'x.js': SRC } });
  await runAgentTurn(session, 'edit', {});
  assert.equal(await readFile(path.join(root, 'x.js'), 'utf8'), SRC);
  assert.match(toolResults(requests)[0].content, /Plan mode blocks/);
});

test('apply_patch cannot reach secret files or leave the workspace', async (t) => {
  const { root, session, requests } = await fixture(t, [
    toolCall('p1', 'apply_patch', { patch: patch('*** Update File: .env\n@@\n-KEY=1\n+KEY=2') }),
    toolCall('p2', 'apply_patch', { patch: patch('*** Add File: ../escaped.txt\n+x') }),
    { content: 'Done.' }
  ], { files: { '.env': 'KEY=1\n' } });
  await runAgentTurn(session, 'edit', {});
  assert.equal(await readFile(path.join(root, '.env'), 'utf8'), 'KEY=1\n');
  await assert.rejects(access(path.join(path.dirname(root), 'escaped.txt')));
  const [first, second] = toolResults(requests);
  assert.match(first.content, /error/i);
  assert.match(second.content, /error/i);
});
