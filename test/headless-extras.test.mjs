import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runHeadless } from '../src/headless.mjs';
import { validateJsonSchema, extractJson } from '../src/json-schema.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

// These scripted fixtures overwrite files without reading them first; read-before-edit
// enforcement is covered by test/file-state.test.mjs.
process.env.OASIS_REQUIRE_READ_BEFORE_EDIT = '0';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
const SCHEMA = { type: 'object', properties: { bugs: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, severity: { enum: ['low', 'high'] } }, required: ['file', 'severity'], additionalProperties: false } }, count: { type: 'integer', minimum: 0 } }, required: ['bugs', 'count'] };

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-hx-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('the schema validator and JSON extraction cover the common subset', () => {
  assert.deepEqual(validateJsonSchema(SCHEMA, { bugs: [{ file: 'a.js', severity: 'high' }], count: 1 }), []);
  const errors = validateJsonSchema(SCHEMA, { bugs: [{ file: 3, severity: 'medium', extra: 1 }], count: -1.5 });
  assert.ok(errors.some((e) => /\$\.bugs\[0\]\.file: expected string/.test(e)));
  assert.ok(errors.some((e) => /severity: must be one of/.test(e)));
  assert.ok(errors.some((e) => /unexpected property "extra"/.test(e)));
  assert.ok(errors.some((e) => /count: expected integer/.test(e)));
  assert.match(validateJsonSchema(SCHEMA, {})[0], /missing required property "bugs"/);
  assert.deepEqual(validateJsonSchema({ anyOf: [{ type: 'string' }, { type: 'null' }] }, null), []);
  assert.deepEqual(validateJsonSchema({ $defs: { n: { type: 'number' } }, items: { $ref: '#/$defs/n' }, type: 'array' }, [1, 'x']).length, 1);
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a":1}\n```').value, { a: 1 });
  assert.deepEqual(extractJson('Result: {"a":[1,2]} done').value, { a: [1, 2] });
  assert.equal(extractJson('no json here').ok, false);
});

test('--json-schema returns structured_output and retries invalid replies', async (t) => {
  const root = await tmp(t);
  const { config, requests } = await scriptedModel(t, [
    { content: 'I found one bug in a.js.' },
    { content: '{"bugs":[{"file":"a.js","severity":"critical"}],"count":1}' },
    { content: '```json\n{"bugs":[{"file":"a.js","severity":"high"}],"count":1}\n```' }
  ]);
  let out = '';
  const { exitCode, summary } = await runHeadless({ prompt: 'find bugs', root, config, outputFormat: 'json', jsonSchema: SCHEMA, sessionOptions: { settings }, write: (text) => { out += text; } });
  assert.equal(exitCode, 0);
  assert.deepEqual(summary.structured_output, { bugs: [{ file: 'a.js', severity: 'high' }], count: 1 });
  assert.deepEqual(JSON.parse(out).structured_output, summary.structured_output);
  assert.match(requests[0].messages.at(-1).content, /must be only a JSON value that matches this JSON Schema/);
  assert.match(requests[1].messages.at(-1).content, /not valid JSON/);
  assert.match(requests[2].messages.at(-1).content, /severity: must be one of/);
});

test('--json-schema gives up after two retries with an error result', async (t) => {
  const root = await tmp(t);
  const { config } = await scriptedModel(t, [{ content: 'nope' }, { content: 'still nope' }, { content: '{"bugs":[]}' }]);
  const { exitCode, summary } = await runHeadless({ prompt: 'x', root, config, outputFormat: 'json', jsonSchema: SCHEMA, sessionOptions: { settings }, write: () => {} });
  assert.equal(exitCode, 1);
  assert.equal(summary.subtype, 'error_max_structured_output_retries');
  assert.match(summary.structured_output_errors[0], /missing required property "count"/);
});

function gitRepo(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' } }).toString().trim();
  git('init', '-q', '-b', 'main');
  return git;
}

async function runCli(t, root, args, script) {
  const home = await tmp(t);
  const { config } = await scriptedModel(t, script);
  const child = spawn(process.execPath, [CLI, '-C', root, ...args], {
    env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_API_KEY: '', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdoutText = '';
  let stderrText = '';
  child.stdout.on('data', (chunk) => { stdoutText += chunk; });
  child.stderr.on('data', (chunk) => { stderrText += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  return { code, stdout: stdoutText, stderr: stderrText };
}

test('oasis -w runs in a worktree, keeps changed ones and removes clean ones', async (t) => {
  const root = await tmp(t);
  const git = gitRepo(root);
  await writeFile(path.join(root, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'init');

  const changed = await runCli(t, root, ['-p', 'edit a.txt', '-w', 'fix-a', '--yes'], [toolCall('c1', 'write_file', { path: 'a.txt', content: 'two\n' }), { content: 'done' }]);
  assert.equal(changed.code, 0, changed.stderr);
  assert.match(changed.stderr, /\[worktree\] Working in \.oasis\/worktrees\/fix-a-[0-9a-f]+ on branch oasis\/fix-a-/);
  assert.match(changed.stderr, /\[worktree\] Kept .* with uncommitted changes/);
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'one\n', 'the main checkout is untouched');
  const kept = changed.stderr.match(/Working in (\S+)/)[1];
  assert.equal(await readFile(path.join(root, kept, 'a.txt'), 'utf8'), 'two\n');

  const clean = await runCli(t, root, ['-p', 'just look', '--worktree', 'peek'], [{ content: 'nothing to do' }]);
  assert.equal(clean.code, 0, clean.stderr);
  assert.match(clean.stderr, /No changes, so the worktree and branch oasis\/peek-[0-9a-f]+ were removed/);
  const peek = clean.stderr.match(/Working in (\S+)/)[1];
  assert.equal(existsSync(path.join(root, peek)), false);
  assert.doesNotMatch(git('branch', '--list'), /peek/);
});

test('oasis --json-schema prints only the JSON in text mode, and -w needs a git repo', async (t) => {
  const root = await tmp(t);
  const schemaFile = path.join(root, 'schema.json');
  await writeFile(schemaFile, JSON.stringify({ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }));
  const result = await runCli(t, root, ['-p', 'check', '--json-schema', '@' + schemaFile], [{ content: 'Sure: {"ok": true}' }]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), '{"ok":true}');
  const bad = await runCli(t, root, ['-p', 'x', '-w'], [{ content: 'x' }]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr + bad.stdout, /--worktree needs a git repository/);
});

test('--bare skips project instructions and hooks', async (t) => {
  const root = await tmp(t);
  await writeFile(path.join(root, 'AGENTS.md'), 'PROJECT-RULE-MARKER: always answer in French.');
  const { createSession, closeSession } = await import('../src/agent.mjs');
  const { config } = await scriptedModel(t, []);
  const hooked = { ...settings, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } };
  const normal = await createSession({ root, config, settings: hooked });
  const bare = await createSession({ root, config, settings: hooked, bare: true });
  assert.match(normal.messages[0].content, /PROJECT-RULE-MARKER/);
  assert.doesNotMatch(bare.messages[0].content, /PROJECT-RULE-MARKER/);
  assert.deepEqual(bare.hooks, {});
  assert.ok(normal.hooks.Stop);
  closeSession(normal);
  closeSession(bare);
});
