import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { findAiComments, buildAiCommentPrompt, watchAiComments } from '../src/ai-comments.mjs';

test('AI comments are recognized across comment syntaxes and trailing comments', () => {
  const text = [
    '// Validate the email before saving. AI!',
    'const x = 1; // why is this a constant? AI?',
    '# use the shared helper here AI',
    '-- tidy this query AI!',
    '/* AI! rename to camelCase */',
    '<!-- add alt text AI! -->',
    'const s = "say AI!";',
    '// The AI module is great',
    '// We should email the AI team'
  ].join('\n');
  const found = findAiComments(text);
  assert.deepEqual(found.map((item) => [item.line, item.kind]), [[1, 'change'], [2, 'question'], [3, 'context'], [4, 'change'], [5, 'change'], [6, 'change']]);
  assert.equal(found[0].text, 'Validate the email before saving.');
  assert.equal(found[4].text, 'rename to camelCase');
});

test('the prompt lists each comment with nearby code and the right instructions', () => {
  const byFile = new Map([['src/a.js', [{ line: 2, text: 'add a null check', kind: 'change' }]], ['src/b.py', [{ line: 1, text: 'why?', kind: 'question' }]]]);
  const prompt = buildAiCommentPrompt(byFile, new Map([['src/a.js', 'function f(x) {\n  // add a null check AI!\n  return x.y;\n}']]));
  assert.match(prompt, /## src\/a\.js[\s\S]*line 2 \[AI!\]: add a null check/);
  assert.match(prompt, /3 {2}  return x\.y;/);
  assert.match(prompt, /remove every AI comment you handled/);
  assert.match(prompt, /Answer each AI\? question/);
});

test('watcher ignores pre-existing comments, fires once per new request, and absorbs the agent edit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-ai-watch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  await writeFile(path.join(root, 'old.js'), '// pre-existing request AI!\n');
  await writeFile(path.join(root, '.env'), '# secret AI!\n');
  await writeFile(path.join(root, '.gitignore'), 'ignored.js\n');
  await writeFile(path.join(root, 'ignored.js'), '// ignored AI!\n');
  const triggers = [];
  const watcher = watchAiComments(root, {
    autoStart: false,
    onTrigger: async ({ byFile, prompt }) => {
      triggers.push({ files: [...byFile.keys()], prompt });
      // Simulate the agent: make the change and remove the handled comment.
      await writeFile(path.join(root, 'app.js'), 'export const add = (a, b) => a + b;\n');
    }
  });
  t.after(() => watcher.stop());
  assert.equal((await watcher.scan()).triggered, false, 'startup scan only primes');
  await writeFile(path.join(root, 'app.js'), 'export const add = (a, b) => a - b; // fix the sign AI!\n');
  const first = await watcher.scan();
  assert.equal(first.triggered, true);
  assert.deepEqual(triggers[0].files.sort(), ['app.js', 'old.js']);
  assert.doesNotMatch(triggers[0].prompt, /secret|ignored/);
  assert.equal((await watcher.scan()).triggered, false, 'the agent edit does not re-trigger');
  assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'export const add = (a, b) => a + b;\n');
  await writeFile(path.join(root, 'other.js'), '// just context AI\n');
  assert.equal((await watcher.scan()).triggered, false, 'context-only comments never fire');
  await writeFile(path.join(root, 'other.js'), '// just context AI\n// now do it AI!\n');
  assert.equal((await watcher.scan()).triggered, true);
  assert.equal(triggers.length, 2);
});
