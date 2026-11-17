import test from 'node:test';
import assert from 'node:assert/strict';
import { commandIntent, commandActivityLabel } from '../app/core/command-intent.mjs';

const intent = (command) => { const { kind, targets } = commandIntent(command); return [kind, targets]; };

test('reading, searching and listing commands read as what they do', () => {
  assert.deepEqual(intent('cat package.json'), ['read', ['package.json']]);
  assert.deepEqual(intent('head -n 40 src/index.js'), ['read', ['src/index.js']]);
  assert.deepEqual(intent("sed -n '1,80p' app/main.mjs"), ['read', ['app/main.mjs']]);
  assert.deepEqual(intent('cat a.js | head -20'), ['read', ['a.js']]);
  assert.deepEqual(intent('rg -n "TODO" src'), ['search', ['TODO']]);
  assert.deepEqual(intent('grep -rn --include=*.js useState .'), ['search', ['useState']]);
  assert.deepEqual(intent("find . -name '*.test.mjs' | head"), ['search', ['*.test.mjs']]);
  assert.deepEqual(intent('git grep -n createServer'), ['search', ['createServer']]);
  assert.deepEqual(intent('ls -la src'), ['list', ['src']]);
  assert.deepEqual(intent('cd app && ls'), ['list', []]);
  assert.deepEqual(intent('rg --files | wc -l'), ['list', []]);
  assert.deepEqual(intent('cat a.js && cat b.js 2>/dev/null'), ['read', ['a.js', 'b.js']]);
  assert.deepEqual(intent('ls src && rg foo src'), ['search', ['foo']]);
  assert.deepEqual(intent('grep foo a.txt 2>&1 | head'), ['search', ['foo']]);
});

test('anything that changes files is never a read or a search', () => {
  for (const command of ['cat a > b', 'cat a >> b', 'find . -name "*.tmp" -delete', 'find . -exec rm {} \\;', 'sort -o out.txt in.txt', "sed -i 's/a/b/' x.js", 'sed -i.bak s/a/b/ x.js', 'cat a | tee b', 'grep foo a | xargs rm', 'rm -rf dist', 'ls && rm x', 'echo hi > a.txt', 'cat $(ls)', 'cat a &', 'npm test', 'node build.mjs', 'git checkout .', 'cat <<EOF > a\nhi\nEOF']) {
    assert.equal(commandIntent(command).kind, 'run', command);
  }
});

test('labels name the file, the pattern or the folder', () => {
  assert.equal(commandActivityLabel(commandIntent('cat src/app/main.mjs')), 'Read main.mjs');
  assert.equal(commandActivityLabel(commandIntent('cat a.js b.js c.js')), 'Read 3 files');
  assert.equal(commandActivityLabel(commandIntent('rg TODO'), { live: true }), 'Searching for TODO');
  assert.equal(commandActivityLabel(commandIntent('ls src/')), 'Listed src');
  assert.equal(commandActivityLabel(commandIntent('ls')), 'Listed project files');
  assert.equal(commandActivityLabel(commandIntent('npm test')), '');
});
