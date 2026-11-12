import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseIgnoreFile, ignoredByRules, agentIgnoreMatch, filterAgentIgnored, AGENT_IGNORE_FILES } from '../src/agent-ignore.mjs';
import { executeTool, walkFiles } from '../src/tools.mjs';
import { grepWorkspace } from '../src/power-tools.mjs';
import { expandFileMentions } from '../src/commands.mjs';

const ignored = (text, rel, isDir = false) => Boolean(ignoredByRules(parseIgnoreFile(text), rel, isDir));

async function fixture(files) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-agent-ignore-'));
  const home = path.join(base, 'home');
  const root = path.join(base, 'repo');
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return { base, home, root, cleanup: () => rm(base, { recursive: true, force: true }) };
}

async function withHome(home, fn) {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try { return await fn(); } finally { process.env.HOME = previous; }
}

test('gitignore syntax: wildcards, anchoring, folders, negation and comments', () => {
  assert.ok(ignored('*.log', 'a/b/debug.log'));
  assert.ok(!ignored('*.log', 'a/b/debug.txt'));
  assert.ok(ignored('secret?.txt', 'secret1.txt'));
  assert.ok(!ignored('secret?.txt', 'secret12.txt'));
  assert.ok(ignored('file[0-9].md', 'docs/file3.md'));
  assert.ok(ignored('/config.json', 'config.json'));
  assert.ok(!ignored('/config.json', 'sub/config.json'));
  assert.ok(ignored('docs/private.md', 'docs/private.md'));
  assert.ok(!ignored('docs/private.md', 'x/docs/private.md'), 'a pattern with a slash is anchored');
  assert.ok(ignored('**/fixtures/*.json', 'a/b/fixtures/x.json'));
  assert.ok(ignored('a/**/b.txt', 'a/b.txt'));
  assert.ok(ignored('a/**/b.txt', 'a/x/y/b.txt'));
  assert.ok(ignored('build/', 'build/out.js'));
  assert.ok(!ignored('build/', 'build'), 'a folder-only pattern skips a file named build');
  assert.ok(ignored('build/', 'build', true));
  assert.ok(!ignored('# *.js\n\n', 'a.js'));
  assert.ok(ignored('\\#notes', '#notes'));
  assert.ok(ignored('space\\ ', 'space '));
  assert.ok(!ignored('*.env\n!example.env', 'example.env'));
  assert.ok(ignored('*.env\n!example.env', 'prod.env'));
});

test('a file inside an excluded folder cannot be re-included (Cursor docs example)', () => {
  const rules = 'public/*\n!public/index.html\n!public/assets/style.css';
  assert.ok(!ignored(rules, 'public/index.html'));
  assert.ok(ignored(rules, 'public/assets/style.css'));
  assert.ok(ignored(rules, 'public/other.html'));
});

test('ignore file list covers Cursor, Devin Desktop, Windsurf, Gemini and Aider', () => {
  const names = AGENT_IGNORE_FILES.map((item) => item.name);
  for (const name of ['.cursorignore', '.devinignore', '.codeiumignore', '.geminiignore', '.aiexclude', '.aiderignore']) assert.ok(names.includes(name), name);
});

test('agent tools refuse to read or write ignored files and hide them from listings', async () => {
  const fx = await fixture({
    '.cursorignore': 'secrets/\n*.private\n',
    'pkg/.devinignore': 'generated.ts\n',
    'secrets/api.txt': 'TOKEN-ABC\n',
    'key.private': 'PEMDATA\n',
    'pkg/generated.ts': 'export const marker = "TOKEN-ABC";\n',
    'pkg/index.ts': 'export const marker = "TOKEN-ABC";\n',
    'src/app.js': 'console.log("TOKEN-ABC");\n',
  });
  try {
    await withHome(fx.home, async () => {
      const { root } = fx;
      await assert.rejects(executeTool('read_file', { path: 'secrets/api.txt' }, { root }), /excluded by \.cursorignore/);
      await assert.rejects(executeTool('read_file', { path: 'key.private' }, { root }), (error) => error.code === 'OASIS_AGENT_IGNORED');
      await assert.rejects(executeTool('read_file', { path: 'pkg/generated.ts' }, { root }), /\.devinignore/);
      await assert.rejects(executeTool('write_file', { path: 'secrets/new.txt', content: 'x' }, { root, autoApprove: true }), /excluded by/);
      assert.match((await executeTool('read_file', { path: 'src/app.js' }, { root })).content, /TOKEN-ABC/);

      const listed = (await executeTool('list_files', { path: '.', includeHidden: true }, { root })).files;
      assert.ok(listed.includes('src/app.js'));
      assert.ok(listed.includes('pkg/index.ts'));
      for (const hidden of ['secrets/api.txt', 'key.private', 'pkg/generated.ts']) assert.ok(!listed.includes(hidden), hidden);

      const globbed = JSON.stringify(await executeTool('glob_files', { pattern: '**/*' }, { root }));
      assert.ok(!globbed.includes('generated.ts') && !globbed.includes('api.txt'), globbed);

      const grep = await grepWorkspace(root, { pattern: 'TOKEN-ABC', output_mode: 'files_with_matches' });
      const found = grep.results.join('\n');
      assert.match(found, /app\.js/);
      assert.match(found, /index\.ts/);
      assert.doesNotMatch(found, /api\.txt|generated\.ts/);

      const searched = JSON.stringify(await executeTool('search_files', { query: 'TOKEN-ABC' }, { root }));
      assert.doesNotMatch(searched, /api\.txt|generated\.ts/);

      const expanded = await expandFileMentions(root, 'look at @secrets/api.txt and @src/app.js');
      const text = typeof expanded === 'string' ? expanded : JSON.stringify(expanded);
      assert.doesNotMatch(text, /<file[^>]*secrets/);
      assert.match(text, /console\.log/);

      const visible = await walkFiles(root, { includeHidden: true, allowIgnored: true });
      assert.ok(visible.some((item) => item.relative.split(path.sep).join('/') === 'secrets/api.txt'), 'user-facing callers can opt out');
    });
  } finally { await fx.cleanup(); }
});

test('the global ~/.codeium/.codeiumignore applies and OASIS_AGENT_IGNORE=0 turns it all off', async () => {
  const fx = await fixture({ 'notes/draft.md': 'draft\n', 'ok.md': 'ok\n' });
  try {
    await mkdir(path.join(fx.home, '.codeium'), { recursive: true });
    await writeFile(path.join(fx.home, '.codeium', '.codeiumignore'), 'notes/\n');
    const match = await agentIgnoreMatch(path.join(fx.root, 'notes', 'draft.md'), { home: fx.home, env: { HOME: fx.home } });
    assert.equal(match && match.tool, 'Windsurf (global)');
    assert.equal(await agentIgnoreMatch(path.join(fx.root, 'ok.md'), { home: fx.home, env: { HOME: fx.home } }), null);
    const kept = await filterAgentIgnored(['notes/draft.md', 'ok.md'].map((rel) => path.join(fx.root, rel)), (item) => item, { home: fx.home, env: { HOME: fx.home } });
    assert.deepEqual(kept.map((item) => path.basename(item)), ['ok.md']);
    assert.equal(await agentIgnoreMatch(path.join(fx.root, 'notes', 'draft.md'), { home: fx.home, env: { HOME: fx.home, OASIS_AGENT_IGNORE: '0' } }), null);
  } finally { await fx.cleanup(); }
});

test('ignore files above the git root are not consulted', async () => {
  const fx = await fixture({ 'a.txt': 'a\n' });
  try {
    await writeFile(path.join(fx.base, '.cursorignore'), '*.txt\n');
    assert.equal(await agentIgnoreMatch(path.join(fx.root, 'a.txt'), { home: fx.home, env: { HOME: fx.home } }), null);
  } finally { await fx.cleanup(); }
});

test('ignore-file matching agrees with git check-ignore', async (t) => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { t.skip('git is not installed'); return; }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-ignore-parity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const sets = [
    ['*.log', '!important.log'], ['/build'], ['build/'], ['doc/**/*.pdf'], ['**/foo'], ['foo/**'], ['a/**/b'], ['logs/', '!logs/keep.log'],
    ['\\#hash', '\\!bang'], ['[abc].txt', '[!a]x'], ['?.md'], ['.env*', '!.env.example'], ['secret/*', '!secret/ok'], ['a[b'],
    ['/*.js', '!/keep.js'], ['x/*/y'], ['*/'], ['**/*.[jt]s'], ['*.txt', '!/sub/*.txt'], ['nested/**/deep', '!nested/x/deep']
  ];
  const paths = ['a.log', 'x/important.log', 'build', 'build/x.js', 'src/build', 'doc/x/y/a.pdf', 'doc/a.pdf', 'x/foo', 'foo/bar/baz', 'a/x/y/b',
    'logs/keep.log', '#hash', '!bang', 'b.txt', 'ax', 'bx', 'a.md', 'ab.md', '.env.local', '.env.example', 'secret/ok', 'secret/no', 'a[b',
    'keep.js', 'sub/keep.js', 'x/q/y', 'x/q/r/y', 'a/f', 'x/y.ts', 'sub/a.txt', 'top.txt', 'nested/a/deep', 'nested/x/deep'];
  for (const set of sets) {
    await writeFile(path.join(dir, '.gitignore'), set.join('\n') + '\n');
    // Exit status 1 only means that nothing was ignored.
    const out = spawnSync('git', ['check-ignore', '--no-index', '--stdin', '-v', '-n'], { cwd: dir, input: paths.join('\n') + '\n', encoding: 'utf8' }).stdout.trim().split('\n');
    assert.equal(out.length, paths.length);
    const rules = parseIgnoreFile(set.join('\n'));
    for (const line of out) {
      const [source, file] = line.split('\t');
      const pattern = source.split(':').slice(2).join(':');
      const expected = Boolean(pattern) && !pattern.startsWith('!');
      assert.equal(Boolean(ignoredByRules(rules, file)), expected, set.join(' | ') + ' :: ' + file);
    }
  }
});
