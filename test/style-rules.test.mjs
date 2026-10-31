import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBuiltinCommand } from '../src/slash.mjs';
import { loadSettings } from '../src/settings.mjs';
import { createSession } from '../src/agent.mjs';
import { executeTool } from '../src/tools.mjs';
import { normalizePhrases, withWritingRules, addedCommentLines, commentWarning, effectivePhrases } from '../src/style-rules.mjs';

test('phrase lists are cleaned and capped', () => {
  assert.deepEqual(normalizePhrases([' load  bearing ', 'Load bearing', '', '<x>', 'a\nb', 'x'.repeat(61), 'robust']), ['load bearing', 'a b', 'robust']);
  assert.deepEqual(normalizePhrases('one'), ['one']);
  assert.equal(normalizePhrases(Array.from({ length: 80 }, (_, i) => 'p' + i)).length, 40);
  assert.deepEqual(effectivePhrases({}, { OASIS_AVOID_PHRASES: '0' }), []);
  assert.deepEqual(effectivePhrases({ avoidPhrases: ['delve'] }, {}), ['load-bearing', 'belt-and-suspenders', 'delve']);
});

test('the writing-rules block is replaced, not stacked', () => {
  const once = withWritingRules('base', ['delve'], 'none');
  const twice = withWritingRules(once, ['tapestry'], null);
  assert.equal((twice.match(/<writing-rules>/g) || []).length, 1);
  assert.match(twice, /"tapestry"/);
  assert.doesNotMatch(twice, /delve|Do not add code comments/);
  assert.equal(withWritingRules(twice, [], null), 'base');
});

test('added comment lines are detected per language', () => {
  assert.deepEqual(addedCommentLines('x = 1\n', 'x = 1\n// set y\ny = 2\n', 'a.js'), ['// set y']);
  assert.deepEqual(addedCommentLines('#a {}\n', '#a {}\n#b {\n', 'a.css'), []);
  assert.deepEqual(addedCommentLines('', '#!/usr/bin/env python\n# bump x\nx += 1\n', 'a.py'), ['# bump x']);
  assert.deepEqual(addedCommentLines('', '#[derive(Debug)]\nstruct A;\n', 'a.rs'), []);
  assert.deepEqual(addedCommentLines('// keep\n', '// keep\nchanged()\n', 'a.ts'), []);
  assert.equal(commentWarning('', '// hi\n', 'a.js', 'minimal'), '');
  assert.equal(commentWarning('', '# Title\n', 'README.md', 'none'), '');
  assert.match(commentWarning('', '// hi\n', 'a.js', 'none'), /Comment rule: .*1 comment line/);
});

test('settings merge phrases across scopes and set the comment mode', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-style-'));
  const config = await mkdtemp(path.join(os.tmpdir(), 'oasis-style-cfg-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(config, { recursive: true, force: true })]));
  await mkdir(path.join(root, '.oasis'));
  await writeFile(path.join(config, 'settings.json'), JSON.stringify({ avoidPhrases: ['delve'], codeComments: 'minimal' }));
  await writeFile(path.join(root, '.oasis', 'settings.json'), JSON.stringify({ avoidPhrases: ['tapestry'], codeComments: 'none' }));
  const env = { ...process.env, OASIS_CONFIG_DIR: config, OASIS_IGNORE_CLAUDE_SETTINGS: '1', OASIS_CODE_COMMENTS: '', OASIS_AVOID_PHRASES: '' };
  const settings = await loadSettings(root, { env, skipPlugins: true });
  assert.deepEqual([...settings.avoidPhrases].sort(), ['delve', 'tapestry']);
  assert.equal(settings.codeComments, 'none');
  const cfg = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'fixture', apiKey: '' };
  const session = await createSession({ root, config: cfg, env });
  assert.equal(session.commentMode, 'none');
  assert.match(session.messages[0].content, /<writing-rules>\nNever use these words or phrases[^\n]*"load-bearing"[^\n]*"delve"/);
  assert.match(session.messages[0].content, /Do not add code comments/);

  await writeFile(path.join(root, 'a.js'), 'const a = 1;\n');
  const result = await executeTool('edit_file', { path: 'a.js', old_string: 'const a = 1;', new_string: '// make a\nconst a = 2;' }, { root, env, session, autoApprove: true });
  assert.match(result.warning || '', /Comment rule/);
});

test('/avoid and /comments persist and update the live prompt', async (t) => {
  const config = await mkdtemp(path.join(os.tmpdir(), 'oasis-style-cmd-'));
  t.after(() => rm(config, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_CONFIG_DIR: config };
  const session = { messages: [{ role: 'system', content: 'You are OASIS.' }], baseSystemPrompt: 'You are OASIS.', avoidPhrases: ['load-bearing'] };
  const added = await runBuiltinCommand('avoid', 'delve', { root: process.cwd(), session, env });
  assert.match(added.output, /Will avoid "delve"/);
  assert.match(session.messages[0].content, /"load-bearing", "delve"/);
  assert.deepEqual(JSON.parse(await readFile(path.join(config, 'settings.json'), 'utf8')).avoidPhrases, ['delve']);
  const listed = await runBuiltinCommand('avoid', '', { root: process.cwd(), session, env });
  assert.match(listed.output, /"delve"/);
  const bad = await runBuiltinCommand('avoid', '<system>', { root: process.cwd(), session, env });
  assert.match(bad.output, /short single-line phrase/);
  await runBuiltinCommand('comments', 'none', { root: process.cwd(), session, env });
  assert.equal(session.commentMode, 'none');
  assert.match(session.messages[0].content, /Do not add code comments/);
  assert.equal(JSON.parse(await readFile(path.join(config, 'settings.json'), 'utf8')).codeComments, 'none');
  await runBuiltinCommand('avoid', 'remove delve', { root: process.cwd(), session, env });
  assert.doesNotMatch(session.messages[0].content, /delve/);
  await runBuiltinCommand('comments', 'default', { root: process.cwd(), session, env });
  await runBuiltinCommand('avoid', 'remove load-bearing', { root: process.cwd(), session, env });
  assert.equal(session.messages[0].content, 'You are OASIS.');
});
