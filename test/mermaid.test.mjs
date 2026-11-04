import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMermaid, parseFlowchart, parseSequence } from '../src/mermaid-ascii.mjs';
import { renderMarkdown, MarkdownStream } from '../src/markdown.mjs';

const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

test('flowchart parsing handles shapes, labels, chains, groups and compact syntax', () => {
  const g = parseFlowchart('flowchart LR\n  A[Start] -->|go| B{Ok?} --> C((End))\n  B -- no --> D(Fix)\n  E & F --> C\n  %% comment\n  classDef x fill:#f00\n  G-->H');
  assert.equal(g.direction, 'LR');
  assert.equal(g.nodes.get('B').shape, 'diamond');
  assert.equal(g.nodes.get('C').label, 'End');
  assert.deepEqual(g.edges.map((e) => e.from + e.to + (e.label || '')), ['ABgo', 'BC', 'BDno', 'EC', 'FC', 'GH']);
  assert.equal(parseFlowchart('pie title x'), null);
});

test('flowcharts render as boxes with arrows; cycles are listed', () => {
  const out = renderMermaid('graph TD\n  A[Start] --> B{Is it ok?}\n  B -->|Yes| C[Ship it]\n  B -->|No| D(Fix bugs)\n  D --> B');
  for (const text of ['│ Start │', '│ Is it ok? │', '│ Ship it │', '│ Fix bugs │', 'Yes', 'No', '▼', '↺ Fix bugs → Is it ok?']) assert.ok(out.includes(text), text + '\n' + out);
  const lr = renderMermaid('graph LR; A-->B; A-->C; B & C --> D');
  assert.ok(lr.includes('▶'));
  assert.equal((lr.match(/│ [ABCD] /g) || []).length, 4);
  const narrow = renderMermaid('graph LR\n' + Array.from({ length: 8 }, (_, i) => 'N' + i + '[A fairly long node label ' + i + '] --> N' + (i + 1)).join('\n'), { columns: 50 });
  assert.ok(narrow.split('\n').every((row) => row.length <= 50), narrow);
});

test('sequence diagrams render lifelines, messages, notes and blocks', () => {
  const src = 'sequenceDiagram\n  participant U as User\n  actor M as Model\n  U->>M: hello\n  M-->>U: hi\n  loop retry\n    M->>M: think\n  end\n  Note over U,M: done';
  assert.equal(parseSequence(src).participants.length, 2);
  const out = renderMermaid(src);
  for (const text of ['│ User │', '│ Model │', 'hello', '▶', '◀', '╌', 'loop retry', '┆ done ┆', '──┐']) assert.ok(out.includes(text), text + '\n' + out);
  assert.equal(renderMermaid('classDiagram\n  A <|-- B'), null);
});

test('markdown renders mermaid fences as diagrams in color mode and keeps source otherwise', () => {
  const md = 'Here:\n```mermaid\ngraph TD\n  A --> B\n```\nafter';
  const colored = strip(renderMarkdown(md, { color: true, columns: 80 }));
  assert.match(colored, /diagram/);
  assert.match(colored, /│ A │/);
  assert.doesNotMatch(colored, /A --> B/);
  assert.match(renderMarkdown(md, { color: false }), /A --> B/);
  assert.match(strip(renderMarkdown('```mermaid\ngantt\n  title x\n```', { color: true })), /gantt/);
  const out = [];
  const stream = new MarkdownStream({ write: (t) => out.push(t), color: true, columns: () => 80 });
  for (const ch of md) stream.push(ch);
  stream.end();
  assert.match(strip(out.join('')), /│ B │/);
  const cut = [];
  const open = new MarkdownStream({ write: (t) => cut.push(t), color: true, columns: () => 80 });
  open.push('```mermaid\ngraph TD\n  X --> Y\n');
  open.end();
  assert.match(strip(cut.join('')), /X --> Y/);
});
