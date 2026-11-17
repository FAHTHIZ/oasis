import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveRegion, clipRow } from '../src/live-region.mjs';
import { createTurnStatus, describeStatus, reasoningGlimpse, todoWindow } from '../src/turn-status.mjs';
import { presentToolActivity } from '../src/tool-activity.mjs';
import { describeTool, middleEllipsis } from '../src/terminal-ui.mjs';
import { MarkdownStream } from '../src/markdown.mjs';

function fakeTty(columns = 40) {
  const out = [];
  const stream = { isTTY: true, columns, write(text) { out.push(String(text)); return true; }, on() {}, off() {} };
  return { stream, out };
}
const manualTimers = () => {
  const queue = [];
  return { timers: { setTimeout: (fn) => { queue.push(fn); return queue.length; }, clearTimeout: () => {} }, run: () => { while (queue.length) queue.shift()(); } };
};

test('the live region batches writes into one synchronized frame', () => {
  const { stream, out } = fakeTty();
  const { timers, run } = manualTimers();
  const region = createLiveRegion({ stream, env: { TERM: 'xterm-256color' }, timers });
  region.attach();
  stream.write('line one\n');
  stream.write('line two\n');
  region.set('status', ['* Working…']);
  run();
  const frame = out.at(-1);
  assert.ok(frame.startsWith('\x1b[?2026h') && frame.endsWith('\x1b[?2026l'), 'synchronized');
  assert.match(frame, /line one\nline two\n\* Working…/);
  stream.write('three\n');
  run();
  assert.match(out.at(-1), /^\x1b\[\?2026h\r\x1b\[J three\n|^\x1b\[\?2026h\r\x1b\[Jthree\n/);
  region.detach();
  assert.equal(stream.write.name, 'write');
  assert.ok(out.join('').includes('\x1b[?25h'), 'cursor shown again');
});

test('a half line hides the live rows until it is finished', () => {
  const { stream, out } = fakeTty();
  const { timers, run } = manualTimers();
  const region = createLiveRegion({ stream, env: {}, timers });
  region.attach();
  region.set('status', ['status']);
  run();
  stream.write('Question? ');
  assert.ok(!out.at(-1).includes('status') && out.at(-1).includes('Question? '));
  region.set('status', ['status 2']);
  run();
  assert.ok(!out.at(-1).includes('status 2'));
  region.detach();
});

test('rows are clipped to the width and erased by their real height', () => {
  assert.equal(clipRow('abcdefghij', 6), 'abcde…\x1b[0m');
  assert.equal(clipRow('\x1b[1mab\x1b[0m', 6), '\x1b[1mab\x1b[0m');
  const { stream, out } = fakeTty(20);
  const { timers, run } = manualTimers();
  const region = createLiveRegion({ stream, env: { OASIS_SYNC_OUTPUT: '0' }, timers });
  region.attach();
  region.set('partial', ['x'.repeat(50)]);
  region.set('status', ['s']);
  run();
  stream.write('done\n');
  run();
  // two rows drawn (blank gap row between partial and status adds one): erase moves up 2.
  assert.match(out.at(-1), /^\r\x1b\[2A\x1b\[J/);
  region.detach();
});

test('suspend clears the rows for a dialog and resume brings them back', () => {
  const { stream, out } = fakeTty();
  const { timers, run } = manualTimers();
  const region = createLiveRegion({ stream, env: {}, timers });
  region.attach();
  region.set('status', ['busy']);
  run();
  region.suspend();
  assert.ok(out.some((chunk) => chunk.includes('\x1b[J')));
  stream.write('dialog row\n');
  assert.equal(out.at(-1), 'dialog row\n');
  region.resume();
  run();
  assert.match(out.at(-1), /busy/);
  region.detach();
});

test('the status line names the step in the present tense with a turn clock', () => {
  const status = describeStatus({ phase: 'draft', draftInfo: { name: 'write_file', path: 'src/a.mjs', chars: 3300 }, outTokens: 1200, step: 3 }, { turnMs: 24000 });
  assert.equal(status.label, 'Writing src/a.mjs · 3.2 KB…');
  assert.equal(status.meta, '24s · ↓ 1.2k tokens · step 3 · esc to stop');
  assert.equal(describeStatus({ phase: 'tool', label: 'Reading package.json' }, { turnMs: 1000 }).label, 'Reading package.json…');
  assert.match(describeStatus({ phase: 'rate', rateLimitMs: 5000 }, { turnMs: 0, phaseMs: 1000 }).meta, /retrying in 4s/);
  assert.match(describeStatus({ phase: 'thinking', typed: 'also fix the readme' }, {}).meta, /› also fix the readme$/);
});

test('present-tense labels for live steps', () => {
  assert.equal(presentToolActivity('read_file', { path: 'src/app.mjs' }), 'Reading app.mjs');
  assert.equal(presentToolActivity('run_command', { command: 'npm', args: ['test'] }), 'Running npm test');
  assert.equal(presentToolActivity('grep', { pattern: 'TODO' }), "Searching for 'TODO'");
  assert.equal(presentToolActivity('todo_write', {}), 'Updating the plan');
});

test('the reasoning glimpse is the latest full sentence', () => {
  assert.equal(reasoningGlimpse('First I read it. Then **I plan** the change. Then'), 'Then I plan the change.');
  assert.equal(reasoningGlimpse(''), '');
});

test('the checklist window keeps the active item in view', () => {
  const todos = Array.from({ length: 10 }, (_, i) => ({ content: 'T' + i, status: i < 7 ? 'completed' : i === 7 ? 'in_progress' : 'pending' }));
  const view = todoWindow(todos, 6);
  assert.ok(view.items.some((t) => t.status === 'in_progress'));
  assert.equal(view.before + view.items.length + view.after, 10);
});

test('turn status draws the checklist with the active form', () => {
  const sets = {};
  const region = { set: (name, rows) => { sets[name] = rows; } };
  let t = 0;
  const status = createTurnStatus({ region, level: 'full', color: false, now: () => t, timers: { setInterval: () => 1, clearInterval: () => {} } });
  status.start({ todos: [{ content: 'Run tests', activeForm: 'Running tests', status: 'in_progress' }, { content: 'Ship', status: 'pending' }] });
  t = 5000;
  status.update({ phase: 'tool', label: 'Reading a.mjs' });
  assert.match(sets.status[0], /Reading a\.mjs… \(5s · esc to stop\)/);
  assert.deepEqual(sets.todos, ['  ◼ Running tests', '  ☐ Ship']);
  // A batch of lookups counts what is done on the row under the status.
  status.update({ phase: 'tool', label: 'Reading a.mjs +2 more', output: '1 of 3 done' });
  assert.match(sets.status[0], /Reading a\.mjs \+2 more…/);
  assert.equal(sets.status[1], '  ⎿ 1 of 3 done');
  status.stop();
  assert.deepEqual(sets.status, []);
});

test('tool headers fit on one row with a middle ellipsis', () => {
  assert.equal(middleEllipsis('abcdefghijklmnopqrstuvwxyz', 11), 'abcdef…wxyz');
  const header = describeTool({ name: 'run_command', args: { command: 'node', args: ['-e', 'x'.repeat(200)] } }, { color: true, columns: 60 });
  const plain = header.replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok([...plain].length <= 59, plain);
  assert.match(plain, /…/);
});

test('live markdown stream hands the partial line to the region', () => {
  let out = '';
  let rows = [];
  const md = new MarkdownStream({ write: (text) => { out += text; }, color: true, prefix: '● ', onPartial: (next) => { rows = next; } });
  md.push('Hello **wor');
  assert.equal(out, '\n');
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].includes('**'), 'unclosed bold markers hidden');
  md.push('ld**\nNext');
  assert.match(out, /^\n● Hello .*world/);
  assert.match(rows[0], /Next/);
  md.end();
  assert.deepEqual(rows, []);
  assert.match(out, /Next\n$/);
});
