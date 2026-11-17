import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activityLabel, liveLabel, toolKind, groupTitle, groupStats, formatDuration, describeInput, buildTimeline, summarizeArgs, fallbackToolLabel } from '../app/core/timeline.mjs';
import { createSoundPlayer, SOUND_KINDS, soundAllowed } from '../app/core/sound.mjs';

const main = readFileSync(new URL('../app/main.mjs', import.meta.url), 'utf8');
const css = readFileSync(new URL('../app/app.css', import.meta.url), 'utf8');

test('steps read as finished work, and the running step reads as what is happening now', () => {
  assert.equal(activityLabel({ name: 'edit_file', args: { path: 'src/math.mjs' } }), 'Edited math.mjs');
  assert.equal(liveLabel({ name: 'edit_file', args: { path: 'src/math.mjs' } }), 'Editing math.mjs');
  assert.equal(activityLabel({ name: 'run_command', args: { command: 'npm', args: ['test'] } }), 'Ran the tests');
  assert.equal(liveLabel({ name: 'run_command', args: { command: 'npm', args: ['test'] } }), 'Running the tests');
  assert.equal(liveLabel({ name: 'run_command', args: { command: 'ls -la' } }), 'Looking through the project');
  assert.equal(liveLabel({ name: 'run_command', args: { command: 'node build.mjs' } }), 'Running node build.mjs');
  assert.equal(activityLabel({ name: 'run_command', args: { command: 'ls' } }), 'Listed project files');
  assert.equal(activityLabel({ name: 'run_command', args: { command: 'make build' } }), 'Ran a command');
  assert.equal(activityLabel({ name: 'task', args: { subagent_type: 'explore' } }), 'Ran the explore agent');
  assert.equal(liveLabel({ name: 'web_search', args: { query: 'node 22 release' } }), 'Searching the web for node 22 release');
  assert.equal(fallbackToolLabel('mcp__context7__resolve-library-id'), 'Used context7: resolve library id');
  assert.equal(liveLabel({ name: 'mcp__github__list_issues' }), 'Using github: list issues');
  assert.equal(summarizeArgs('grep', { pattern: 'TODO', path: 'src' }), 'TODO  in src');
});

test('tools map to a kind that picks the step icon', () => {
  assert.equal(toolKind('run_command'), 'shell');
  assert.equal(toolKind('read_file'), 'read');
  assert.equal(toolKind('multi_edit'), 'edit');
  assert.equal(toolKind('grep'), 'search');
  assert.equal(toolKind('fetch_url'), 'web');
  assert.equal(toolKind('git_diff'), 'git');
  assert.equal(toolKind('task'), 'agent');
  assert.equal(toolKind('todo_write'), 'plan');
  assert.equal(toolKind('mcp__x__y'), 'tool');
});

test('a finished group sums up its steps; a live group names the running step', () => {
  const steps = [
    { id: '1', name: 'read_file', args: { path: 'a.mjs' }, ok: true, startedAt: 1000, endedAt: 1100 },
    { id: '2', name: 'read_file', args: { path: 'b.mjs' }, ok: true, startedAt: 1100, endedAt: 1200 },
    { id: '3', name: 'edit_file', args: { path: 'a.mjs' }, ok: true, startedAt: 1200, endedAt: 1500 },
    { id: '4', name: 'edit_file', args: { path: 'a.mjs' }, ok: false, startedAt: 1500, endedAt: 1600 },
    { id: '5', name: 'run_command', args: { command: 'npm test' }, ok: true, startedAt: 1600, endedAt: 13600 }
  ];
  assert.equal(groupTitle(steps), 'Read a.mjs and b.mjs, edited a.mjs and ran the tests');
  assert.equal(groupTitle([...steps.slice(0, 2), { id: '6', name: 'read_file', args: { path: 'c.mjs' }, ok: true }]), 'Read 3 files');
  assert.equal(groupTitle([steps[0], { id: '7', name: 'list_files', args: { path: 'test' }, ok: true }]), 'Read 2 files');
  assert.equal(groupTitle([{ id: 't', name: 'task', args: { subagent_type: 'explore' }, ok: true }, steps[0]]), 'Ran the explore agent and read a.mjs');
  assert.deepEqual(groupStats(steps), { total: 5, failed: 1, declined: 0, blocked: 0, stopped: 0, running: 0, durationMs: 12600 });
  assert.equal(groupTitle([steps[0]]), 'Read a.mjs');
  assert.equal(groupTitle([...steps.slice(0, 2), { id: '6', name: 'write_file', args: { path: 'c.mjs' } }]), 'Writing c.mjs');
  assert.equal(groupStats([{ id: 'x', name: 'grep', startedAt: 1 }]).durationMs, null, 'no total while a step runs');
});

test('durations are short and readable', () => {
  assert.equal(formatDuration(20), '<0.1s');
  assert.equal(formatDuration(420), '0.4s');
  assert.equal(formatDuration(null), '');
  assert.equal(formatDuration(undefined), '');
  assert.equal(formatDuration(12_400), '12s');
  assert.equal(formatDuration(65_000), '1m 05s');
  assert.equal(formatDuration(undefined), '');
  assert.equal(formatDuration(-5), '');
});

test('the step inspector shows commands, diffs and file bodies, and hides secrets', () => {
  assert.deepEqual(describeInput({ name: 'run_command', args: { command: 'npm', args: ['test'], cwd: 'pkg' } }), [
    { label: 'Command', format: 'command', text: 'npm test' },
    { label: 'Folder', format: 'text', text: 'pkg' }
  ]);
  const edit = describeInput({ name: 'edit_file', args: { path: 'm.mjs', old_string: 'a - b', new_string: 'a + b' } });
  assert.equal(edit[1].format, 'diff');
  assert.equal(edit[1].old, 'a - b');
  assert.equal(describeInput({ name: 'write_file', args: { path: 't.mjs', content: 'x' } })[1].format, 'code');
  const raw = describeInput({ name: 'configure_provider', args: { provider: 'openrouter', apiKey: 'sk-or-secret', _label: 'x' } });
  assert.equal(raw[0].format, 'json');
  assert.ok(!raw[0].text.includes('sk-or-secret'), 'API keys never reach the inspector');
  assert.ok(raw[0].text.includes('[hidden]'));
  assert.ok(!raw[0].text.includes('_label'));
  assert.deepEqual(describeInput({ name: 'git_status', args: {} }), []);
});

test('saved chats group consecutive tool-only steps until the agent speaks', () => {
  const blocks = buildTimeline([
    { role: 'user', content: 'Fix add()' },
    { role: 'assistant', content: 'Looking at math.mjs first.', tools: [{ id: 'a', name: 'read_file' }] },
    { role: 'assistant', content: '', tools: [{ id: 'b', name: 'grep' }] },
    { role: 'assistant', content: '', tools: [{ id: 'c', name: 'edit_file' }], subagents: [{ id: 's1', status: 'completed' }] },
    { role: 'assistant', content: 'Fixed. Running the tests.', tools: [{ id: 'd', name: 'run_command' }] },
    { role: 'note', content: 'Stopped.' },
    { role: 'assistant', content: 'All green.', tools: [] }
  ]);
  assert.deepEqual(blocks.map((block) => block.type), ['user', 'text', 'group', 'text', 'group', 'note', 'text']);
  assert.deepEqual(blocks[2].steps.map((step) => step.id), ['a', 'b', 'c']);
  assert.equal(blocks[2].subagents.length, 1);
  assert.deepEqual(blocks[4].steps.map((step) => step.id), ['d']);
});

test('the app renders live and saved turns through the same timeline', () => {
  assert.ok(main.includes('renderSavedDisplay(display)'));
  assert.ok(main.includes('buildTimeline(entries)'));
  assert.ok(main.includes("head.setAttribute('aria-expanded', String(open))") || main.includes("group.head.setAttribute('aria-expanded', String(open))"));
  assert.match(css, /\.steps\.running/);
  assert.match(css, /prefers-reduced-motion/);
});

test('sounds are short, rendered once and never stack', () => {
  let enabled = false;
  const sources = [];
  const buffers = [];
  class FakeContext {
    constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
    createBuffer(channels, length, rate) { const data = new Float32Array(length); const buffer = { length, rate, copyToChannel: (samples) => data.set(samples), getChannelData: () => data }; buffers.push(buffer); return buffer; }
    createBufferSource() { const source = { connect: (node) => node, start: () => {} }; sources.push(source); return source; }
    createGain() { return { gain: { value: 1 }, connect: (node) => node }; }
  }
  const play = createSoundPlayer({ enabled: () => enabled, win: { AudioContext: FakeContext } });
  assert.equal(play('done'), false, 'off unless allowed');
  enabled = true;
  assert.equal(play('done'), true);
  assert.equal(sources.length, 1);
  assert.ok(buffers[0].length > 2000 && buffers[0].length < 22050, 'under a second');
  assert.equal(play('fail'), false, 'a second sound right away is dropped');
  assert.equal(play('nope'), false);
  assert.deepEqual(SOUND_KINDS.sort(), ['done', 'fail', 'input', 'send']);
  assert.equal(createSoundPlayer({ enabled: () => true, win: {} })('done'), false, 'no Web Audio, no sound, no error');
});

test('by default only done and needs-you play, and only in the background', () => {
  const hidden = { hidden: true, hasFocus: () => false };
  const shown = { hidden: false, hasFocus: () => true };
  assert.equal(soundAllowed(null, 'done', hidden), true);
  assert.equal(soundAllowed(undefined, 'input', hidden), true);
  assert.equal(soundAllowed(null, 'send', hidden), false);
  assert.equal(soundAllowed(null, 'done', shown), false);
  assert.equal(soundAllowed(true, 'send', shown), true);
  assert.equal(soundAllowed(false, 'done', hidden), false);
});

test('the thinking chip shows elapsed time after five seconds', async () => {
  const { thinkingLabel } = await import('../app/core/timeline.mjs');
  assert.equal(thinkingLabel(0), 'Thinking');
  assert.equal(thinkingLabel(999), 'Thinking');
  assert.equal(thinkingLabel(4999), 'Thinking · 5s');
  assert.equal(thinkingLabel(12_000), 'Thinking · 12s');
  assert.equal(thinkingLabel(125_000), 'Thinking · 2m 05s');
  assert.equal(thinkingLabel(Number.NaN), 'Thinking');
});

test('a tool call streamed as JSON text is recognised while it streams', async () => {
  const { splitTextToolCall } = await import('../app/core/timeline.mjs');
  const streamingTextToolCall = (text) => splitTextToolCall(text).tool;
  assert.equal(streamingTextToolCall('{\n  "name": "write_file",\n  "arguments": {\n    "path": "src/index.html"'), 'write_file');
  assert.equal(streamingTextToolCall('```json\n{"name": "run_command", "parameters": {"command": "npm test"'), 'run_command');
  assert.equal(streamingTextToolCall('<tool_call>\n{"name":"read_file","arguments":{'), 'read_file');
  assert.equal(streamingTextToolCall('Here is the plan: {"name": "x"}'), '');
  assert.equal(streamingTextToolCall('{"name": "Ada", "age": 3}'), '');
  assert.equal(streamingTextToolCall(''), '');
});

test('prose before a JSON tool call is kept and the call is split off', async () => {
  const { splitTextToolCall } = await import('../app/core/timeline.mjs');
  assert.deepEqual(splitTextToolCall('File src/index.html created.{"name": "delete_file", "arguments": {"path":"src/index.html"}}'), { text: 'File src/index.html created.', tool: 'delete_file' });
  assert.deepEqual(splitTextToolCall('Plain answer.'), { text: 'Plain answer.', tool: '' });
  assert.deepEqual(splitTextToolCall('Now:\n```json\n{"name": "run_command", "arguments": {'), { text: 'Now:', tool: 'run_command' });
});

test('summaries stay honest: declined, blocked and stopped steps are never counted as work done', async () => {
  const { stepOutcome, stepLabel } = await import('../app/core/timeline.mjs');
  const declined = { id: 'a', name: 'run_command', args: { command: 'npm', args: ['install'] }, ok: false, outcome: 'declined' };
  const read = { id: 'b', name: 'read_file', args: { path: 'src/a.mjs' }, ok: true, outcome: 'ok', startedAt: 1, endedAt: 2 };
  assert.equal(stepOutcome(declined), 'declined');
  assert.equal(stepOutcome({ ok: false }), 'failed', 'older saved steps keep ok/failed');
  assert.equal(stepOutcome({}), 'running');
  assert.equal(stepLabel(declined), 'You declined: npm install');
  assert.equal(groupTitle([declined]), 'You declined: npm install', 'a declined command never reads "Ran a command"');
  assert.equal(groupTitle([read, declined]), 'Read a.mjs');
  const stats = groupStats([read, declined, { id: 'c', name: 'grep', ok: false, outcome: 'blocked' }]);
  assert.deepEqual({ failed: stats.failed, declined: stats.declined, blocked: stats.blocked }, { failed: 0, declined: 1, blocked: 1 });
  assert.equal(groupTitle([{ ...declined, id: 'x' }, { id: 'y', name: 'grep', args: { pattern: 'x' }, ok: false, outcome: 'blocked' }]), 'Nothing ran: 1 declined, 1 blocked');
});

test('a group title names at most three kinds of work, then how many more', () => {
  const steps = [
    { id: '1', name: 'read_file', args: { path: 'a' }, ok: true },
    { id: '2', name: 'edit_file', args: { path: 'b' }, ok: true },
    { id: '3', name: 'web_search', args: { query: 'q' }, ok: true },
    { id: '4', name: 'git_status', args: {}, ok: true },
    { id: '5', name: 'todo_write', args: {}, ok: true }
  ];
  // Plan updates stay out of titles (the plan card shows them); a fourth kind is named.
  assert.equal(groupTitle(steps), 'Read a, edited b, searched the web and checked project changes');
  assert.equal(groupTitle([...steps, { id: '6', name: 'run_command', args: { command: 'ls -la' }, ok: true }]), 'Read a, edited b, searched the web and 2 more');
  assert.equal(groupTitle([{ id: '5', name: 'todo_write', args: {}, ok: true }]), 'Updated the task plan');
});

test('a failed step says what did not happen instead of the past tense', async () => {
  const { stepLabel } = await import('../app/core/timeline.mjs');
  assert.equal(stepLabel({ id: 'a', name: 'write_file', args: { path: 'notes.txt' }, ok: false }), "Couldn't write notes.txt");
  assert.equal(groupTitle([{ id: 'a', name: 'write_file', args: { path: 'notes.txt' }, ok: false }]), "Couldn't write notes.txt");
  assert.equal(stepLabel({ id: 'b', name: 'run_command', args: { command: 'npm test' }, ok: false }), 'Tests failed');
  assert.equal(stepLabel({ id: 'c', name: 'run_command', args: { command: 'make' }, ok: false }), 'Command failed');
  assert.equal(stepLabel({ id: 'c2', name: 'run_command', args: { command: 'cat missing.js' }, ok: false }), "Couldn't read missing.js");
  assert.equal(stepLabel({ id: 'd', name: 'edit_file', args: { path: 'a.js' }, ok: false, outcome: 'timed_out' }), 'Timed out trying to edit a.js');
  assert.equal(stepLabel({ id: 'e', name: 'write_file', args: { path: 'notes.txt' }, ok: true }), 'Wrote notes.txt');
});

test('step output reads as text, not the JSON a tool returned', async () => {
  const { readableOutput } = await import('../app/core/timeline.mjs');
  assert.equal(readableOutput('{"error":"File has not been read yet"}\nThis step failed: File has not been read yet'), 'This step failed: File has not been read yet');
  assert.equal(readableOutput('{"error":"Nope"}'), 'Nope');
  const command = JSON.stringify({ command: 'cat', approved: true, exitCode: 1, signal: null, stdout: '', stderr: 'cat: missing.txt: No such file or directory\n', stdoutTruncated: false, stderrTruncated: false, timedOut: false, cancelled: false });
  assert.equal(readableOutput(command + '\nThe command failed (exit code 1).'), 'cat: missing.txt: No such file or directory\nThe command failed (exit code 1).');
  assert.equal(readableOutput(JSON.stringify({ exitCode: 0, stdout: 'a\nb\n', stderr: '' })), 'a\nb');
  assert.equal(readableOutput(JSON.stringify({ exitCode: 0, stdout: '', stderr: '' })), 'Finished with no output.');
  assert.equal(readableOutput(JSON.stringify({ exitCode: 2, stdout: '', stderr: 'boom' })), 'boom\nExit code 2.');
  assert.equal(readableOutput('{"path":"a.txt","bytes":3}'), '{"path":"a.txt","bytes":3}');
  assert.equal(readableOutput('plain text'), 'plain text');
});

test('a reply repeated word for word in the same turn is recognised', async () => {
  const { repeatsEarlierReply } = await import('../app/core/timeline.mjs');
  const first = { role: 'assistant', content: 'Changed notes.txt.', tools: [] };
  const second = { role: 'assistant', content: '', tools: [] };
  const entries = [{ role: 'user', content: 'Edit' }, first, { role: 'assistant', content: '', tools: [{ id: 'a' }] }, second];
  assert.equal(repeatsEarlierReply(entries, second, 'Changed  notes.txt.\n'), true);
  assert.equal(repeatsEarlierReply(entries, second, 'Something else.'), false);
  assert.equal(repeatsEarlierReply(entries, first, 'Changed notes.txt.'), false, 'not against itself');
  const later = [...entries, { role: 'user', content: 'Again' }, second];
  assert.equal(repeatsEarlierReply(later, second, 'Changed notes.txt.'), false, 'an earlier turn does not count');
});

test('plan, read and search steps open to a readable view, not raw JSON', async () => {
  const { readableOutput } = await import('../app/core/timeline.mjs');
  const plan = describeInput({ name: 'todo_write', args: { todos: [{ content: 'Explore', status: 'completed' }, { content: 'Write it', activeForm: 'Writing it', status: 'in_progress' }, { content: 'Check', status: 'pending' }] } });
  assert.equal(plan[0].format, 'checklist');
  assert.deepEqual(plan[0].items.map((item) => item.text + ':' + item.status), ['Explore:completed', 'Writing it:in_progress', 'Check:pending']);
  assert.deepEqual(describeInput({ name: 'read_file', args: { path: 'src/a.mjs', offset: 10, limit: 5 } }), [
    { label: 'File', format: 'path', text: 'src/a.mjs' },
    { label: 'Lines', format: 'text', text: '10–14' }
  ]);
  assert.equal(describeInput({ name: 'grep', args: { pattern: 'TODO', path: 'src' } })[0].text, 'TODO');
  assert.equal(describeInput({ name: 'list_files', args: { path: '.' } })[0].text, 'Project folder');
  assert.equal(readableOutput(JSON.stringify({ path: 'a.txt', content: 'hello\nworld' })), 'hello\nworld');
  assert.equal(readableOutput(JSON.stringify({ todos: [{ status: 'completed' }, { status: 'pending' }], remaining: 1 })), '1 of 2 done.');
  assert.equal(readableOutput(JSON.stringify({ query: 'x', matches: [{ path: 'a.mjs', line: 3, text: '  const x = 1;' }] })), 'a.mjs:3  const x = 1;');
  assert.equal(readableOutput(JSON.stringify({ path: '.', files: ['a', 'b/c'], truncated: false })), 'a\nb/c');
  assert.equal(describeInput({ name: 'list_files', args: { path: '.', _label: 'x' } })[0].format, 'path');
  // Anything else keeps its exact text.
  assert.equal(readableOutput(JSON.stringify({ path: 'a', content: 'x', extra: 1 })), JSON.stringify({ path: 'a', content: 'x', extra: 1 }));
});


test('a command moved to the background after its time limit says so, not "Timed out"', async () => {
  const { readableOutput, stepLabel } = await import('../app/core/timeline.mjs');
  const content = JSON.stringify({ command: 'npm run dev', exitCode: null, stdout: 'listening on 3000\n', stderr: '', timedOut: true, movedToBackground: true, background: true, id: 'bg_3' });
  assert.equal(readableOutput(content), 'listening on 3000\nStill running in the background after the time limit (bg_3). OASIS will say when it exits.');
  assert.match(stepLabel({ name: 'run_command', args: { command: 'npm run dev' }, ok: true, outcome: 'ok', content }), /^Moved to the background: .*npm run dev/);
  assert.equal(readableOutput(JSON.stringify({ exitCode: null, stdout: '', stderr: '', timedOut: true })), 'Timed out.');
});

test('formatDuration reads a long run in hours ("Worked for 1h 02m 05s")', () => {
  assert.equal(formatDuration(3540000), '59m 00s');
  assert.equal(formatDuration(3725000), '1h 02m 05s');
});

test('a finished step says what came back in one line, as Claude Code does', async () => {
  const { stepResult, testSummary, readableOutput } = await import('../app/core/timeline.mjs');
  const read = (value) => stepResult({ ok: true, content: JSON.stringify(value) }).text;
  assert.equal(read({ path: 'a.js', content: 'x\ny\nz' }), 'Read 3 lines');
  assert.equal(read({ path: 'a.js', content: 'x', startLine: 1, endLine: 200, totalLines: 1204, truncated: true }), 'Read lines 1–200 of 1,204');
  assert.equal(read({ matches: [{ path: 'a', line: 1 }, { path: 'b', line: 2 }, { path: 'b', line: 9 }] }), '3 matches in 2 files');
  assert.equal(read({ matches: [] }), 'No matches');
  assert.equal(read({ files: ['a', 'b'] }), '2 files');
  assert.equal(stepResult({ ok: true, name: 'git_diff', content: JSON.stringify({ exitCode: 0, stdout: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n-old\n+new\n+more\n', stderr: '' }) }).text, '1 file changed · +2 −1');
  assert.equal(readableOutput(JSON.stringify({ path: 'src/dates.mjs', changed: true, replacements: 1, added: 1, removed: 1, beforeBytes: 10, afterBytes: 12, backupCreated: true })), 'Changed src/dates.mjs: 1 line added, 1 removed.');
  assert.equal(read({ pattern: 'x', mode: 'content', engine: 'ripgrep', results: ['src/a.mjs:1:x', 'src/a.mjs-2-ctx', 'src/b.mjs:9:x'], count: 3, truncated: false }), '2 matches in 2 files');
  assert.equal(read({ pattern: 'x', mode: 'files_with_matches', results: ['a', 'b', 'c'], truncated: true }), '3 files+');
  assert.equal(read({ pattern: 'x', mode: 'count', results: ['a:2', 'b:5'] }), '7 matches in 2 files');
  assert.equal(read({ pattern: 'x', mode: 'content', results: [] }), 'No matches');
  assert.equal(readableOutput(JSON.stringify({ pattern: 'x', mode: 'content', engine: 'ripgrep', results: ['a:1:x'], count: 1, truncated: false })), 'a:1:x');
  assert.equal(read({ todos: [] }), '');
  assert.equal(read({ command: 'npm test', exitCode: 0, stdout: '# pass 12\n# fail 0\n', stderr: '' }), '12 passed');
  assert.deepEqual(stepResult({ ok: false, content: JSON.stringify({ command: 'npm test', exitCode: 1, stdout: 'Tests: 1 failed, 11 passed, 12 total', stderr: '' }) }), { text: '11 passed · 1 failed · exit code 1', tone: 'fail' });
  assert.deepEqual(stepResult({ ok: false, content: JSON.stringify({ command: 'foo', exitCode: 127, stdout: '', stderr: 'sh: foo: command not found' }) }), { text: 'Exit code 127 · sh: foo: command not found', tone: 'fail' });
  assert.equal(read({ command: 'ls', exitCode: 0, stdout: 'a\nb\n', stderr: '' }), '2 lines of output');
  assert.deepEqual(stepResult({ ok: false, content: '{"error":"File not found: x.js"}' }), { text: 'File not found: x.js', tone: 'fail' });
  assert.equal(stepResult({ content: 'still running' }).text, '');
  assert.equal(testSummary('===== 3 passed, 1 skipped in 0.2s ====='), '3 passed · 1 skipped');
  assert.equal(testSummary('12 passing\n2 failing'), '12 passed · 2 failed');
  // A ranged read shows the file text in the inspector, not its JSON envelope.
  assert.equal(readableOutput(JSON.stringify({ path: 'a.js', content: 'x\ny', startLine: 1, endLine: 2, totalLines: 2, truncated: false })), 'x\ny');
});

test('an edit previews its change inline: changed lines with one line of context', async () => {
  const { diffPreview, stepResult } = await import('../app/core/timeline.mjs');
  const ops = [
    { type: 'same', text: 'a' }, { type: 'same', text: 'b' }, { type: 'del', text: 'c' }, { type: 'add', text: 'C' },
    { type: 'same', text: 'd' }, { type: 'same', text: 'e' }, { type: 'same', text: 'f' }, { type: 'add', text: 'g' },
  ];
  const { rows, more } = diffPreview(ops, 10);
  assert.deepEqual(rows.map((row) => row.type === 'gap' ? '…' : row.text), ['b', 'c', 'C', 'd', '…', 'f', 'g']);
  assert.equal(more, 0);
  const many = Array.from({ length: 30 }, (_, index) => ({ type: 'add', text: String(index) }));
  const cut = diffPreview(many, 10);
  assert.equal(cut.rows.length, 10);
  assert.equal(cut.more, 20);
  assert.equal(stepResult({ ok: true, name: 'write_file', args: { path: 'a', content: 'x\ny\n' }, content: 'ok' }).text, 'Wrote 2 lines');
});

test('a settled thought is titled by its headline', async () => {
  const { thoughtHeadline } = await import('../app/core/timeline.mjs');
  assert.equal(thoughtHeadline('grep shows isOverdue in src/dates.mjs. Read it.'), 'Grep shows isOverdue in src/dates.mjs');
  assert.equal(thoughtHeadline('**Planning the fix**\n\nI will compare days.'), 'Planning the fix');
  assert.equal(thoughtHeadline('1. Read the file\n2. Fix it'), 'Read the file');
  assert.equal(thoughtHeadline('See [the docs](https://x.y) first: then edit.'), 'See the docs first: then edit');
  assert.equal(thoughtHeadline(''), '');
  assert.ok(thoughtHeadline('word '.repeat(60)).endsWith('…'));
  assert.ok(thoughtHeadline('word '.repeat(60)).length <= 96);
});
