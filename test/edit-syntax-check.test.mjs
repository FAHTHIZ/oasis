import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nodeSyntaxCheck } from '../src/lsp.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

// Benchmark run 2026-11-15 (qwen3 1.7B, slice-lines): the model wrote
// `text.split(/\r?` + a real newline + `/g)`, and without a language server
// nothing said so until the final check.
const broken = 'export function sliceLines(text) {\n  return text.split(/\\r?\n/g);\n}\n';
const fine = 'export function sliceLines(text) {\n  return text.split(/\\r?\\n/g);\n}\n';

async function tempRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-syntax-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('nodeSyntaxCheck reports a file that does not parse, without running it', async (t) => {
  const root = await tempRoot(t);
  await writeFile(path.join(root, 'bad.mjs'), broken);
  await writeFile(path.join(root, 'good.mjs'), fine);
  // Running this file would create ran.txt; a parse-only check must not.
  await writeFile(path.join(root, 'side.mjs'), "import { writeFileSync } from 'node:fs';\nwriteFileSync('ran.txt', 'x');\n");
  const bad = await nodeSyntaxCheck(root, 'bad.mjs');
  assert.equal(bad.status, 'error');
  assert.match(bad.output, /SyntaxError/);
  assert.match(bad.output, /bad\.mjs/);
  assert.ok(!bad.output.includes(root), 'paths are shown relative to the project');
  assert.equal(await nodeSyntaxCheck(root, 'good.mjs'), null);
  assert.equal(await nodeSyntaxCheck(root, 'side.mjs'), null);
  await assert.rejects(readFile(path.join(root, 'ran.txt')), /ENOENT/);
  assert.equal(await nodeSyntaxCheck(root, 'notes.txt'), null, 'other file types are skipped');
  assert.equal(await nodeSyntaxCheck(root, 'missing.mjs'), null, 'a missing file is not a syntax error');
  assert.equal(await nodeSyntaxCheck(root, 'bad.mjs', { env: { OASIS_EDIT_SYNTAX_CHECK: '0' } }), null);
});

async function writeThroughAgent(t, content) {
  const root = await tempRoot(t);
  const { config } = await scriptedModel(t, [
    toolCall('w1', 'write_file', { path: 'src/lib.mjs', content }),
    { content: 'Written.' }
  ]);
  // No language server can start here, the way most machines without one look.
  const session = await createSession({ root, config, settings: { permissions: { allow: [], ask: [], deny: [] } }, bare: true });
  const previous = process.env.PATH;
  process.env.PATH = path.join(root, 'no-bin');
  try { await runAgentTurn(session, 'Write the module.', { approval: async () => true }); }
  finally { process.env.PATH = previous; }
  const message = session.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'w1');
  assert.ok(message, 'write result recorded');
  return JSON.parse(message.content);
}

test('a write that leaves a JavaScript file unparseable says so in the same result', async (t) => {
  const result = await writeThroughAgent(t, broken);
  assert.equal(result.syntaxCheck && result.syntaxCheck.status, 'error', JSON.stringify(result).slice(0, 800));
  assert.match(result.warning, /does not parse: SyntaxError/);
});

test('a write that parses carries no syntax warning', async (t) => {
  const result = await writeThroughAgent(t, fine);
  assert.equal(result.syntaxCheck, undefined, JSON.stringify(result).slice(0, 800));
  assert.ok(!/does not parse/.test(result.warning || ''));
});
