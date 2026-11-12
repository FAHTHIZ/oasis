import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activityLabel, liveLabel, toolKind, groupTitle, groupStats, formatDuration, describeInput, buildTimeline, summarizeArgs, fallbackToolLabel } from '../app/core/timeline.mjs';
import { createSoundPlayer, SOUND_KINDS } from '../app/core/sound.mjs';
import { particleCount } from '../app/core/ambient.mjs';

const main = readFileSync(new URL('../app/main.mjs', import.meta.url), 'utf8');
const css = readFileSync(new URL('../app/app.css', import.meta.url), 'utf8');

test('steps read as finished work, and the running step reads as what is happening now', () => {
  assert.equal(activityLabel({ name: 'edit_file', args: { path: 'src/math.mjs' } }), 'Edited math.mjs');
  assert.equal(liveLabel({ name: 'edit_file', args: { path: 'src/math.mjs' } }), 'Editing math.mjs');
  assert.equal(activityLabel({ name: 'run_command', args: { command: 'npm', args: ['test'] } }), 'Ran the tests');
  assert.equal(liveLabel({ name: 'run_command', args: { command: 'npm', args: ['test'] } }), 'Running the tests');
  assert.equal(liveLabel({ name: 'run_command', args: { command: 'ls -la' } }), 'Running ls -la');
  assert.equal(activityLabel({ name: 'run_command', args: { command: 'ls' } }), 'Ran a command');
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
  assert.equal(groupTitle(steps), 'Read 2 files, edited a.mjs and ran the tests');
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

test('sounds are opt-in, short and never stack', () => {
  let enabled = false;
  const made = [];
  class FakeContext {
    constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
    createOscillator() { const osc = { frequency: {}, connect: (node) => node, start: () => {}, stop: () => {} }; made.push(osc); return osc; }
    createGain() { const ramp = () => {}; return { gain: { setValueAtTime: ramp, exponentialRampToValueAtTime: ramp }, connect: (node) => node }; }
  }
  const play = createSoundPlayer({ enabled: () => enabled, win: { AudioContext: FakeContext } });
  assert.equal(play('done'), false, 'off by default');
  enabled = true;
  assert.equal(play('done'), true);
  assert.equal(made.length, 2);
  assert.equal(play('fail'), false, 'a second sound right away is dropped');
  assert.equal(play('nope'), false);
  assert.deepEqual(SOUND_KINDS.sort(), ['done', 'fail', 'input', 'send']);
  assert.equal(createSoundPlayer({ enabled: () => true, win: {} })('done'), false, 'no Web Audio, no sound, no error');
});

test('the particle field stays small on any screen', () => {
  assert.equal(particleCount(390, 844), 18);
  assert.equal(particleCount(1440, 900), 50);
  assert.equal(particleCount(3840, 2160), 70);
});

test('the thinking chip shows elapsed time after five seconds', async () => {
  const { thinkingLabel } = await import('../app/core/timeline.mjs');
  assert.equal(thinkingLabel(0), 'Thinking');
  assert.equal(thinkingLabel(4999), 'Thinking');
  assert.equal(thinkingLabel(12_000), 'Thinking · 12s');
  assert.equal(thinkingLabel(125_000), 'Thinking · 2m 05s');
  assert.equal(thinkingLabel(Number.NaN), 'Thinking');
});

test('a tool call streamed as JSON text is recognised while it streams', async () => {
  const { streamingTextToolCall } = await import('../app/core/timeline.mjs');
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
  assert.equal(groupTitle(steps), 'Read a, edited b, searched the web and 2 more');
});
