import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { KeyDecoder, createEditorState, applyKey, layoutFrame, stringWidth, commonPrefix, readInput } from '../src/line-editor.mjs';
import { createCompleter, rankFuzzy } from '../src/completion.mjs';
import { loadHistory, appendHistory } from '../src/input-history.mjs';
import { renderMarkdown, MarkdownStream, renderDiff, highlightCode } from '../src/markdown.mjs';
import { animationEnabled, logoFrame, footerFor, nextMode, startupTip, describeEdit, describeTool, runShellPassthrough, shellContextBlock, verboseToolOutput } from '../src/terminal-ui.mjs';

const keys = (raw) => new KeyDecoder().feed(raw);
const typeAll = (state, raw) => { for (const key of keys(raw)) state = applyKey(state, key).state; return state; };

test('calm mode disables startup animation regardless of terminal colour support', () => {
  assert.equal(animationEnabled({ isTTY: true }, { OASIS_NO_ANIMATION: '1' }), false);
  assert.equal(animationEnabled({ isTTY: true }, { TERM: 'dumb' }), false);
});

test('startup tips rotate daily and can be disabled', () => {
  const first = startupTip({}, 1);
  const nextDay = startupTip({}, 86_400_001);
  assert.ok(first);
  assert.ok(nextDay);
  assert.notEqual(first, nextDay);
  assert.equal(startupTip({ OASIS_TIP: 'off' }, 1), '');
  assert.equal(startupTip({ OASIS_NO_TIPS: '1' }, 1), '');
});

test('key decoder understands arrows, modifiers, shift+enter, and bracketed paste across chunks', () => {
  assert.deepEqual(keys('\x1b[A\x1b[B\x1b[1;5C\x1b[Z').map((k) => k.name), ['up', 'down', 'wordRight', 'shiftTab']);
  assert.deepEqual(keys('\x1b[13;2u').map((k) => k.name), ['newline']);
  assert.deepEqual(keys('\x1b\r').map((k) => k.name), ['newline']);
  const decoder = new KeyDecoder();
  assert.deepEqual(decoder.feed('\x1b[200~line one\r\nline'), []);
  const done = decoder.feed(' two\x1b[201~');
  assert.equal(done.length, 1);
  assert.equal(done[0].name, 'paste');
  assert.equal(done[0].text, 'line one\nline two');
  assert.deepEqual(keys('\x1b').map((k) => k.name), ['escape']);
});

test('editor edits text, supports multi-line input, kill/yank, undo, and history navigation', () => {
  let state = createEditorState({ history: ['first', 'second'] });
  state = typeAll(state, 'hello world');
  state = applyKey(state, { name: 'killWord' }).state;
  assert.equal(state.text, 'hello ');
  state = applyKey(state, { name: 'yank' }).state;
  assert.equal(state.text, 'hello world');
  state = applyKey(state, { name: 'undo' }).state;
  assert.equal(state.text, 'hello ');
  state = applyKey(state, { name: 'newline' }).state;
  state = typeAll(state, 'next');
  assert.equal(state.text, 'hello \nnext');
  // Up inside multi-line moves between lines before reaching history.
  state = applyKey(state, { name: 'up' }).state;
  assert.equal(state.text, 'hello \nnext');
  state = applyKey(state, { name: 'up' }).state;
  assert.equal(state.text, 'second');
  state = applyKey(state, { name: 'up' }).state;
  assert.equal(state.text, 'first');
  state = applyKey(state, { name: 'down' }).state;
  state = applyKey(state, { name: 'down' }).state;
  assert.equal(state.text, 'hello \nnext', 'draft restored after history');
  // Trailing backslash continues the line instead of submitting.
  let cont = typeAll(createEditorState(), 'a\\');
  const result = applyKey(cont, { name: 'enter' });
  assert.equal(result.action, null);
  assert.equal(result.state.text, 'a\n');
  cont = typeAll(createEditorState(), 'done');
  assert.equal(applyKey(cont, { name: 'enter' }).action, 'submit');
  assert.equal(applyKey(createEditorState(), { name: 'ctrlD' }).action, 'eof');
});

test('Ctrl+R searches history and accepts the match', () => {
  let state = createEditorState({ history: ['run the tests', 'fix the build', 'run lint'] });
  state = applyKey(state, { name: 'search' }).state;
  state = typeAll(state, 'run');
  assert.equal(state.search.match, 2);
  state = applyKey(state, { name: 'search' }).state;
  assert.equal(state.search.match, 0);
  state = applyKey(state, { name: 'enter' }).state;
  assert.equal(state.search, null);
  assert.equal(state.text, 'run the tests');
});

test('layout wraps long lines and places the cursor correctly', () => {
  const frame = layoutFrame({ prompt: '> ', continuation: '  ', text: 'x'.repeat(18) + '\nab', cursor: 21, columns: 10, hints: ['hint'] });
  // Line 1: 2 + 18 = 20 cells → 2 rows; line 2 starts on row 2.
  assert.equal(frame.cursorRow, 2);
  assert.equal(frame.cursorCol, 4);
  assert.equal(frame.endRow, 3);
  assert.equal(stringWidth('日本'), 4);
  assert.equal(stringWidth('\x1b[31mred\x1b[39m'), 3);
  assert.equal(commonPrefix(['/compact', '/commit', '/commands']), '/com');
});

test('readInput drives a fake TTY: typing, Tab completion, and submit', async () => {
  const input = new PassThrough();
  input.isTTY = true; input.setRawMode = () => {}; input.isRaw = false;
  const output = new PassThrough();
  output.columns = 80; let written = '';
  output.on('data', (chunk) => { written += chunk; });
  const pending = readInput({ input, output, color: false, prompt: '> ', complete: async (text, cursor) => ({ start: 0, end: cursor, candidates: [{ value: '/compact' }] }) });
  input.write('/comp');
  input.write('\t');
  input.write('\r');
  const result = await pending;
  assert.equal(result.type, 'submit');
  assert.equal(result.text, '/compact ');
  assert.match(written, /\x1b\[\?2004h/);
});

test('Ctrl+K opens a searchable command palette and inserts a choice without running it', async () => {
  const input = new PassThrough();
  input.isTTY = true; input.setRawMode = () => {}; input.isRaw = false;
  const output = new PassThrough();
  output.columns = 80; output.rows = 24;
  let written = '';
  output.on('data', (chunk) => { written += chunk; });
  const pending = readInput({
    input, output, color: false, prompt: '> ', env: { OASIS_SAFE_MODE: '1' },
    onCommandPalette: async () => [
      { label: '/doctor', description: 'Diagnose setup problems', value: '/doctor', category: 'Commands' },
      { label: '/help', description: 'Show the command list', value: '/help', category: 'Commands' },
      { label: 'Resume recent session', description: 'Open saved work', value: '/resume abcdef0123456789abcdef01', category: 'Recent sessions' }
    ]
  });
  input.write('\x0b');
  input.write('help\r\r');
  const result = await pending;
  assert.equal(result.type, 'submit');
  assert.equal(result.text, '/help');
  assert.match(written, /OASIS COMMAND PALETTE/);
  assert.match(written, /Search: help/);
  assert.match(written, /Added \/help to the prompt/);
  assert.match(written, /\x1b\[\?1049h/);
  assert.match(written, /\x1b\[\?1049l/);
});

test('completion offers slash commands at the start and @files with fuzzy matching', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-complete-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'cli.mjs'), '');
  await writeFile(path.join(root, 'README.md'), '');
  await writeFile(path.join(root, '.env'), 'SECRET=1');
  const complete = createCompleter({ root, commands: async () => [{ name: 'compact', description: 'Summarize' }, { name: 'commit' }, { name: 'help' }] });
  const slash = await complete('/com', 4);
  assert.deepEqual(slash.candidates.map((c) => c.value).sort(), ['/commit', '/compact']);
  assert.equal(await complete('say /com', 8), null, 'slash only completes at the start');
  const files = await complete('look at @s', 10);
  assert.ok(files.candidates.some((c) => c.value === '@src/'));
  const fuzzy = await complete('@cli', 4);
  assert.ok(fuzzy.candidates.some((c) => c.value === '@src/cli.mjs'));
  const hidden = await complete('@.e', 3);
  assert.ok(!hidden.candidates.some((c) => c.value === '@.env'), 'secret files are never offered');
  assert.deepEqual(rankFuzzy(['src/agent.mjs', 'src/cli.mjs', 'docs/cli.md'], 'cli'), ['docs/cli.md', 'src/cli.mjs']);
});

test('history persists per workspace and skips space-prefixed prompts', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-history-'));
  const env = { OASIS_HOME: home };
  await appendHistory('/work/a', 'first task', { env });
  await appendHistory('/work/b', 'other project', { env });
  await appendHistory('/work/a', ' secret prompt', { env });
  await appendHistory('/work/a', 'second task', { env });
  assert.deepEqual(await loadHistory('/work/a', { env }), ['first task', 'second task']);
  assert.deepEqual(await loadHistory('/work/b', { env }), ['other project']);
});

test('markdown renders headings, lists, inline code, and highlighted code blocks while streaming', () => {
  const plain = renderMarkdown('# Title\n- item\n```js\nconst a = 1;\n```', { color: false });
  assert.equal(plain, '# Title\n- item\n  const a = 1;');
  const colored = renderMarkdown('## Head\n- **bold** and `code`', { color: true });
  assert.match(colored, /\x1b\[1mHead/);
  assert.match(colored, /• /);
  assert.match(colored, /\x1b\[36mcode/);
  assert.match(highlightCode('const x = "s"; // note', 'js'), /\x1b\[35mconst/);
  let out = '';
  const stream = new MarkdownStream({ write: (t) => { out += t; }, color: true, prefix: '● ' });
  stream.push('Hello **wor');
  stream.push('ld**\n- one');
  stream.end();
  assert.match(out, /\x1b\[1mworld/);
  assert.match(out, /• one/);
});

test('diffs show additions and removals for edits', () => {
  const diff = renderDiff('a\nb\nc', 'a\nB\nc\nd', { color: false });
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 1);
  assert.match(diff.text, /- b/);
  assert.match(diff.text, /\+ B/);
  const shown = describeEdit({ name: 'edit_file', args: { path: 'x.js', old_string: 'one', new_string: 'two' }, result: { ok: true } }, { color: false });
  assert.match(shown, /Updated x\.js with 1 addition and 1 removal/);
  assert.equal(describeEdit({ name: 'edit_file', args: {}, result: { error: 'nope' } }), '');
  assert.match(describeTool({ name: 'read_file', args: { path: 'a.js' } }, { color: true }), /Read.*\(a\.js\)/);
});

test('banner, footer, and mode cycling', () => {
  const frame = logoFrame(1, -1, false);
  assert.equal(frame.length, 5);
  assert.ok(frame[0].includes('██'));
  assert.ok(logoFrame(1, 10, true)[0].includes('\x1b[38;2;'));
  assert.equal(nextMode('default'), 'acceptEdits');
  assert.equal(nextMode('auto'), 'default');
  assert.equal(nextMode('auto', { allowBypass: true }), 'bypassPermissions');
  assert.match(footerFor({ mode: 'plan', color: false }), /plan mode on/);
  assert.match(footerFor({ text: '!ls', color: false }), /shell mode/);
  assert.equal(footerFor({ mode: 'default', color: false }), '');
  const metrics = footerFor({ model: 'qwen2.5-coder:3b', contextPercent: 91, costLabel: '$0.90', budgetUsd: 1, spentUsd: 0.91, color: false });
  assert.match(metrics, /model qwen2\.5-coder:3b/);
  assert.match(metrics, /! context 91%/);
  assert.match(metrics, /cost \$0\.90 \/ \$1\.00 budget/);
  assert.match(metrics, /! budget 91% used/);
});

test('! shell mode runs the command and returns output for context', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-bang-'));
  const sink = new PassThrough();
  const ran = await runShellPassthrough('echo hi && exit 3', { root, output: sink, env: { PATH: process.env.PATH, OPENAI_API_KEY: 'x' } });
  assert.equal(ran.code, 3);
  assert.match(ran.output, /hi/);
  assert.match(shellContextBlock([{ command: 'ls', code: 0, output: 'a\n' }]), /<bash-input>ls<\/bash-input>/);
});


test('verbose tool output does not repeat identical payloads exposed under aliases', () => {
  const rendered = verboseToolOutput('tool', {
    output: 'same payload',
    content: 'same payload'
  });
  assert.equal(rendered.split('same payload').length - 1, 1);
});

test('verbose tool output preserves distinct stdout and stderr', () => {
  const rendered = verboseToolOutput('tool', {
    stdout: 'standard output',
    stderr: 'standard error'
  });
  assert.match(rendered, /standard output/);
  assert.ok(rendered.includes('[stderr]'));
  assert.ok(rendered.indexOf('[stderr]') < rendered.indexOf('standard error'));
});
