import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBuiltinCommand, BUILTIN_COMMANDS } from '../src/slash.mjs';

async function workspace(t, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-slash-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
  return root;
}
const env = { ...process.env, OASIS_AUTO_TEST: '', HOME: os.tmpdir() };

test('/test with a passing command reports success and does not start a model turn', async (t) => {
  assert.ok(BUILTIN_COMMANDS.test);
  const root = await workspace(t);
  const printed = [];
  const result = await runBuiltinCommand('test', 'node -e "process.exit(0)"', { root, env, print: (line) => printed.push(line) });
  assert.match(result.output, /^\[test\] Passed: node -e/);
  assert.equal(result.prompt, undefined);
  assert.match(printed[0], /Running node -e/);
});

test('/test hands a failure to the model with the output tail', async (t) => {
  const root = await workspace(t);
  const result = await runBuiltinCommand('test', 'node -e "console.log(\'expected 8, got 0\'); process.exit(3)"', { root, env });
  assert.match(result.output, /failed with exit code 3/);
  assert.match(result.output, /expected 8, got 0/);
  assert.match(result.prompt, /I ran the tests myself and they failed with exit code 3/);
  assert.match(result.prompt, /expected 8, got 0/);
});

test('/test uses the package.json test script, falls back to the model, and is off in restricted mode', async (t) => {
  const withScript = await workspace(t, { 'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }) });
  assert.match((await runBuiltinCommand('test', '', { root: withScript, env })).output, /Passed: npm test/);
  const empty = await workspace(t, { 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
  const fallback = await runBuiltinCommand('test', '', { root: empty, env });
  assert.match(fallback.output, /No test command is configured/);
  assert.match(fallback.prompt, /Find how this project runs its tests/);
  const restricted = await runBuiltinCommand('test', 'node -v', { root: empty, env, sessionOptions: { restricted: true } });
  assert.match(restricted.output, /restricted/);
  assert.equal(restricted.prompt, undefined);
});
