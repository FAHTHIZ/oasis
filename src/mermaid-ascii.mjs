// Render Mermaid diagrams as box-drawing text for the terminal.
// Supports flowchart/graph (TD/TB/BT/LR/RL, node shapes, labeled and chained edges,
// "&" groups, subgraph members) with a layered layout, and sequenceDiagram
// (participants/actors, messages, self messages, notes, loop/alt/opt/par blocks).
// State and class diagrams and xychart are drawn by beautiful-mermaid
// (MIT, lukilabs/beautiful-mermaid), loaded on first use. Anything else, or a
// drawing wider than the terminal, returns null so the caller can show the source.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { stringWidth } from './line-editor.mjs';

const U = 1, D = 2, L = 4, R = 8;
const JOIN = { 1: '│', 2: '│', 3: '│', 4: '─', 8: '─', 12: '─', 10: '┌', 6: '┐', 9: '└', 5: '┘', 11: '├', 7: '┤', 14: '┬', 13: '┴', 15: '┼' };

class Canvas {
  constructor() { this.cells = new Map(); this.masks = new Map(); this.w = 0; this.h = 0; }
  key(x, y) { return y * 100000 + x; }
  grow(x, y) { if (x + 1 > this.w) this.w = x + 1; if (y + 1 > this.h) this.h = y + 1; }
  put(x, y, ch) { if (x < 0 || y < 0) return; this.cells.set(this.key(x, y), ch); this.grow(x, y); }
  text(x, y, s) { let col = x; for (const ch of String(s)) { this.put(col, y, ch); const w = stringWidth(ch); for (let i = 1; i < w; i++) this.put(col + i, y, ''); col += Math.max(1, w); } }
  mask(x, y, m) { if (x < 0 || y < 0) return; const k = this.key(x, y); this.masks.set(k, (this.masks.get(k) || 0) | m); this.grow(x, y); }
  hline(x1, x2, y) { const a = Math.min(x1, x2), b = Math.max(x1, x2); for (let x = a; x <= b; x++) this.mask(x, y, (x > a ? L : 0) | (x < b ? R : 0)); }
  vline(x, y1, y2) { const a = Math.min(y1, y2), b = Math.max(y1, y2); for (let y = a; y <= b; y++) this.mask(x, y, (y > a ? U : 0) | (y < b ? D : 0)); }
  toString() {
    const rows = [];
    for (let y = 0; y < this.h; y++) {
      let row = '';
      for (let x = 0; x < this.w; x++) {
        const k = this.key(x, y);
        if (this.cells.has(k)) row += this.cells.get(k);
        else if (this.masks.has(k)) row += JOIN[this.masks.get(k)] || ' ';
        else row += ' ';
      }
      rows.push(row.replace(/\s+$/, ''));
    }
    while (rows.length && !rows[rows.length - 1]) rows.pop();
    return rows.join('\n');
  }
}

function clean(text) {
  return String(text || '').replace(/^["'`]|["'`]$/g, '').replace(/<br\s*\/?>/gi, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

// ---------- flowchart ----------
const SHAPES = [
  [/^\(\[(.*)\]\)$/s, 'round'], [/^\[\[(.*)\]\]$/s, 'box'], [/^\[\((.*)\)\]$/s, 'round'], [/^\(\((.*)\)\)$/s, 'round'],
  [/^\{\{(.*)\}\}$/s, 'diamond'], [/^\[\/(.*)[\/\\]\]$/s, 'box'], [/^\[\\(.*)[\/\\]\]$/s, 'box'],
  [/^\((.*)\)$/s, 'round'], [/^\{(.*)\}$/s, 'diamond'], [/^\[(.*)\]$/s, 'box'], [/^>(.*)\]$/s, 'box']
];
const NODE_RE = /^([A-Za-z0-9_](?:\w|\.(?!-)|-(?![-.>x]|$))*)\s*(\(\[.*?\]\)|\[\[.*?\]\]|\[\(.*?\)\]|\(\(.*?\)\)|\{\{.*?\}\}|\[\/.*?[\/\\]\]|\[\\.*?[\/\\]\]|\(.*?\)|\{.*?\}|\[.*?\]|>.*?\])?(?::::\w+)?/s;
const EDGE_RE = /^\s*(?:(?<b1><?)(?<l1>-{2,}|={2,}|-\.+-)(?<h1>>|x|o)?\|(?<t1>[^|]*)\||(?<b3><?)(?<l3>--|==|-\.)\s+(?<t3>[^-=>.|\s][^>]*?)\s+(?:-{2,}|={2,}|\.+-)(?<h3>>|x|o)?|(?<b2><?)(?<l2>-{2,}|={2,}|-\.+-)(?<h2>>|x|o)?|~~~)\s*/s;

function parseNodeGroup(text, nodes) {
  const ids = [];
  let rest = text;
  for (;;) {
    rest = rest.replace(/^\s+/, '');
    const m = NODE_RE.exec(rest);
    if (!m) return null;
    const id = m[1];
    let label = null, shape = null;
    if (m[2]) for (const [re, kind] of SHAPES) { const s = re.exec(m[2]); if (s) { label = clean(s[1]); shape = kind; break; } }
    if (!nodes.has(id)) nodes.set(id, { id, label: label || id, shape: shape || 'box' });
    else if (label !== null) Object.assign(nodes.get(id), { label, shape });
    ids.push(id);
    rest = rest.slice(m[0].length);
    const amp = /^\s*&\s*/.exec(rest);
    if (!amp) return { ids, rest };
    rest = rest.slice(amp[0].length);
  }
}

export function parseFlowchart(source) {
  const lines = String(source).split(/\n|;(?=\s*(?:\n|$|[A-Za-z]))/).map((l) => l.replace(/%%.*$/, '').trim()).filter(Boolean);
  const head = /^(flowchart|graph)\b\s*(TD|TB|BT|LR|RL)?/i.exec(lines[0] || '');
  if (!head) return null;
  const direction = (head[2] || 'TD').toUpperCase();
  const nodes = new Map();
  const edges = [];
  for (const line of lines.slice(1)) {
    if (/^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/.test(line) || line === 'end') continue;
    const sub = /^subgraph\s+(.*)$/.exec(line);
    if (sub) continue;
    let group = parseNodeGroup(line, nodes);
    if (!group) continue;
    let rest = group.rest;
    while (rest && rest.trim()) {
      const e = EDGE_RE.exec(rest);
      if (!e) break;
      const g = e.groups;
      const label = clean(g.t1 !== undefined ? g.t1 : g.t3 !== undefined ? g.t3 : '');
      const head2 = g.h1 || g.h2 || g.h3 || '';
      const bidirectional = Boolean(g.b1 || g.b2 || g.b3);
      const dotted = /\./.test(g.l1 || g.l2 || g.l3 || '');
      const invisible = /^\s*~~~/.test(e[0]);
      const next = parseNodeGroup(rest.slice(e[0].length), nodes);
      if (!next) break;
      if (!invisible) for (const from of group.ids) for (const to of next.ids) edges.push({ from, to, label, arrow: head2 === '>' || head2 === 'x' || head2 === 'o', bidirectional, dotted });
      group = next;
      rest = next.rest;
    }
  }
  return nodes.size ? { direction, nodes, edges } : null;
}

function layer(graph) {
  const ids = [...graph.nodes.keys()];
  const out = new Map(ids.map((id) => [id, []]));
  graph.edges.forEach((edge, index) => { if (edge.from !== edge.to) out.get(edge.from).push({ to: edge.to, index }); });
  // Break cycles: edges to a node on the DFS stack become back edges.
  const state = new Map();
  const back = new Set();
  const visit = (id) => {
    state.set(id, 1);
    for (const { to, index } of out.get(id)) {
      if (state.get(to) === 1) back.add(index);
      else if (!state.get(to)) visit(to);
    }
    state.set(id, 2);
  };
  const indegree = new Map(ids.map((id) => [id, 0]));
  graph.edges.forEach((e) => { if (e.from !== e.to) indegree.set(e.to, indegree.get(e.to) + 1); });
  for (const id of ids) if (!indegree.get(id) && !state.get(id)) visit(id);
  for (const id of ids) if (!state.get(id)) visit(id);
  const forward = graph.edges.map((e, i) => ({ ...e, index: i })).filter((e, i) => e.from !== e.to && !back.has(i));
  const rank = new Map(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const e of forward) if (rank.get(e.to) < rank.get(e.from) + 1) { rank.set(e.to, rank.get(e.from) + 1); changed = true; }
    if (!changed) break;
  }
  const backEdges = graph.edges.filter((e, i) => back.has(i) || e.from === e.to);
  return { rank, forward, backEdges };
}

function buildLayers(graph) {
  const { rank, forward, backEdges } = layer(graph);
  const layers = [];
  const vertex = new Map();
  for (const [id, r] of rank) {
    const node = graph.nodes.get(id);
    vertex.set(id, { id, label: node.label, shape: node.shape, rank: r, dummy: false });
    (layers[r] ||= []).push(id);
  }
  const segments = [];
  let dummyCount = 0;
  for (const e of forward) {
    let prev = e.from;
    for (let r = rank.get(e.from) + 1; r < rank.get(e.to); r++) {
      const id = '\u0000d' + dummyCount++;
      vertex.set(id, { id, rank: r, dummy: true });
      layers[r].push(id);
      segments.push({ from: prev, to: id, last: false, edge: e });
      prev = id;
    }
    segments.push({ from: prev, to: e.to, last: true, edge: e });
  }
  // Order each layer by the barycenter of its neighbors, a few sweeps both ways.
  const pos = new Map();
  const index = () => layers.forEach((ids) => ids.forEach((id, i) => pos.set(id, i)));
  index();
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    const order = down ? layers.map((_, i) => i).slice(1) : layers.map((_, i) => i).reverse().slice(1);
    for (const r of order) {
      const score = new Map();
      for (const id of layers[r]) {
        const near = segments.filter((s) => (down ? s.to === id : s.from === id)).map((s) => pos.get(down ? s.from : s.to));
        score.set(id, near.length ? near.reduce((a, b) => a + b, 0) / near.length : pos.get(id));
      }
      layers[r].sort((a, b) => score.get(a) - score.get(b));
      index();
    }
  }
  return { layers, vertex, segments, backEdges };
}

// Cross-axis placement: each node tries to sit centered on its parents, without overlap;
// then everything is shifted so the smallest coordinate is 0.
function place(layers, vertex, segments, size, start, center, spacing) {
  layers.forEach((ids, r) => {
    let next = -Infinity;
    for (const id of ids) {
      const v = vertex.get(id);
      const parents = r ? segments.filter((s) => s.to === id).map((s) => vertex.get(s.from)[center]) : [];
      const desired = parents.length ? Math.round(parents.reduce((a, b) => a + b, 0) / parents.length) - Math.floor(v[size] / 2) : (next === -Infinity ? 0 : next);
      v[start] = Math.max(desired, next);
      v[center] = v[start] + Math.floor(v[size] / 2);
      next = v[start] + Math.max(1, v[size]) + spacing;
    }
  });
  const min = Math.min(...[...vertex.values()].map((v) => v[start]));
  for (const v of vertex.values()) { v[start] -= min; v[center] -= min; }
}

function drawBox(canvas, x, y, w, label, shape) {
  const [tl, tr, bl, br] = shape === 'round' ? ['╭', '╮', '╰', '╯'] : shape === 'diamond' ? ['╱', '╲', '╲', '╱'] : ['┌', '┐', '└', '┘'];
  canvas.text(x, y, tl + '─'.repeat(w - 2) + tr);
  canvas.text(x, y + 1, '│ ' + label + ' '.repeat(Math.max(0, w - 4 - stringWidth(label))) + ' │');
  canvas.text(x, y + 2, bl + '─'.repeat(w - 2) + br);
}

function lanes(spans) {
  // Greedy interval coloring so horizontal runs in one gap never overlap.
  const sorted = spans.map((s, i) => ({ ...s, i })).sort((a, b) => Math.min(a.a, a.b) - Math.min(b.a, b.b));
  const ends = [];
  const lane = new Array(spans.length).fill(0);
  for (const s of sorted) {
    const lo = Math.min(s.a, s.b), hi = Math.max(s.a, s.b);
    if (lo === hi) { lane[s.i] = -1; continue; }
    let k = ends.findIndex((end) => end < lo - 1);
    if (k === -1) { k = ends.length; ends.push(hi); } else ends[k] = hi;
    lane[s.i] = k;
  }
  return { lane, count: Math.max(1, ends.length) };
}

const truncate = (text, max) => stringWidth(text) <= max ? text : [...text].slice(0, Math.max(1, max - 1)).join('') + '…';

function renderVertical(graph, maxLabel) {
  const { layers, vertex, segments } = buildLayers(graph);
  const canvas = new Canvas();
  for (const v of vertex.values()) if (!v.dummy) { v.label = truncate(v.label, maxLabel); v.w = stringWidth(v.label) + 4; } else v.w = 1;
  place(layers, vertex, segments, 'w', 'x', 'cx', 3);
  let y = 0;
  for (let r = 0; r < layers.length; r++) {
    for (const id of layers[r]) {
      const v = vertex.get(id);
      v.y = y;
      if (v.dummy) canvas.vline(v.cx, y, y + 2); else drawBox(canvas, v.x, y, v.w, v.label, v.shape);
    }
    y += 3;
    const gap = segments.filter((s) => vertex.get(s.from).rank === r);
    if (!gap.length) { y += 1; continue; }
    const { lane, count } = lanes(gap.map((s) => ({ a: vertex.get(s.from).cx, b: vertex.get(s.to).cx })));
    const labelRow = y + 1 + count;
    gap.forEach((s, i) => {
      const from = vertex.get(s.from), to = vertex.get(s.to);
      const laneY = y + Math.max(0, lane[i]);
      if (!from.dummy) canvas.put(from.cx, y - 1, '┬');
      canvas.vline(from.cx, y - 1, laneY);
      if (lane[i] >= 0) canvas.hline(from.cx, to.cx, laneY);
      canvas.vline(to.cx, laneY, labelRow + 1);
      if (s.last && s.edge.arrow) canvas.put(to.cx, labelRow + 1, '▼');
      if (s.last && s.edge.label) canvas.text(to.cx + 2, labelRow, truncate(s.edge.label, maxLabel));
    });
    y = labelRow + 2;
  }
  return canvas;
}

function renderHorizontal(graph, maxLabel) {
  const { layers, vertex, segments } = buildLayers(graph);
  const canvas = new Canvas();
  for (const v of vertex.values()) if (!v.dummy) { v.label = truncate(v.label, maxLabel); v.w = stringWidth(v.label) + 4; v.h = 3; } else { v.w = 0; v.h = 1; }
  place(layers, vertex, segments, 'h', 'y', 'cy', 1);
  let x = 0;
  for (let r = 0; r < layers.length; r++) {
    const colWidth = Math.max(1, ...layers[r].map((id) => vertex.get(id).w));
    for (const id of layers[r]) {
      const v = vertex.get(id);
      v.x = x; v.right = x + colWidth;
      if (v.dummy) canvas.hline(x - 1, x + colWidth, v.cy);
      else { drawBox(canvas, x, v.y, v.w, v.label, v.shape); if (v.w < colWidth) canvas.hline(x + v.w, x + colWidth, v.cy); }
    }
    x += colWidth;
    const gap = segments.filter((s) => vertex.get(s.from).rank === r);
    if (!gap.length) { x += 2; continue; }
    const { lane, count } = lanes(gap.map((s) => ({ a: vertex.get(s.from).cy, b: vertex.get(s.to).cy })));
    const labelWidth = Math.max(0, ...gap.filter((s) => s.last && s.edge.label).map((s) => stringWidth(truncate(s.edge.label, maxLabel)) + 2));
    const laneX0 = x + 1;
    const end = laneX0 + count + labelWidth + 1;
    gap.forEach((s, i) => {
      const from = vertex.get(s.from), to = vertex.get(s.to);
      const laneX = laneX0 + Math.max(0, lane[i]);
      if (!from.dummy) canvas.put(from.x + from.w - 1, from.cy, '├');
      canvas.hline(x - (from.dummy ? 0 : 0), laneX, from.cy);
      if (lane[i] >= 0) canvas.vline(laneX, from.cy, to.cy);
      canvas.hline(laneX, end, to.cy);
      if (s.last && s.edge.label) canvas.text(laneX0 + count + 1, to.cy, truncate(s.edge.label, maxLabel));
      if (s.last && s.edge.arrow) canvas.put(end, to.cy, '▶');
    });
    x = end + 1;
  }
  return canvas;
}

function renderFlowchart(source, { columns = 100, maxLabel = 28 } = {}) {
  const graph = parseFlowchart(source);
  if (!graph) return null;
  if (graph.nodes.size > 60) return null;
  const horizontal = graph.direction === 'LR' || graph.direction === 'RL';
  let text = (horizontal ? renderHorizontal(graph, maxLabel) : renderVertical(graph, maxLabel)).toString();
  const tooWide = text.split('\n').some((row) => stringWidth(row) > columns);
  if (tooWide && horizontal) text = renderVertical(graph, maxLabel).toString();
  if (text.split('\n').some((row) => stringWidth(row) > columns)) {
    // Fall back to an edge list that always fits.
    text = graph.edges.map((e) => graph.nodes.get(e.from).label + (e.bidirectional ? ' ↔ ' : e.arrow ? ' → ' : ' — ') + graph.nodes.get(e.to).label + (e.label ? '  (' + e.label + ')' : '')).join('\n');
  }
  const { backEdges } = layer(graph);
  if (backEdges.length && !text.includes(' → ')) text += '\n' + backEdges.map((e) => '↺ ' + graph.nodes.get(e.from).label + ' → ' + graph.nodes.get(e.to).label + (e.label ? '  (' + e.label + ')' : '')).join('\n');
  return text;
}

// ---------- sequence diagram ----------
const MESSAGE_RE = /^([^\s:+-][^:]*?)\s*(-->>|->>|-->|->|--x|-x|--\)|-\))\s*([+-]?)([^:]+?)\s*:\s*(.*)$/;

export function parseSequence(source) {
  const lines = String(source).split('\n').map((l) => l.replace(/%%.*$/, '').trim()).filter(Boolean);
  if (!/^sequenceDiagram\b/.test(lines[0] || '')) return null;
  const participants = [];
  const byId = new Map();
  const ensure = (id, label = id, actor = false) => {
    id = id.trim();
    if (!byId.has(id)) { const p = { id, label: clean(label), actor }; byId.set(id, p); participants.push(p); }
    return byId.get(id);
  };
  const steps = [];
  for (const line of lines.slice(1)) {
    let m;
    if ((m = /^(participant|actor)\s+(\S+?)(?:\s+as\s+(.+))?$/.exec(line))) { ensure(m[2], m[3] || m[2], m[1] === 'actor'); continue; }
    if ((m = /^(loop|alt|opt|par|critical|break|rect)\b\s*(.*)$/.exec(line))) { steps.push({ type: 'block', kind: m[1], label: clean(m[2]) }); continue; }
    if ((m = /^(else|and|option)\b\s*(.*)$/.exec(line))) { steps.push({ type: 'divider', kind: m[1], label: clean(m[2]) }); continue; }
    if (line === 'end') { steps.push({ type: 'end' }); continue; }
    if ((m = /^note\s+(over|left of|right of)\s+([^:]+):\s*(.*)$/i.exec(line))) {
      const ids = m[2].split(',').map((s) => ensure(s).id);
      steps.push({ type: 'note', where: m[1].toLowerCase(), ids, text: clean(m[3]) });
      continue;
    }
    if (/^(autonumber|activate|deactivate|title|box|create|destroy|links?)\b/.test(line)) continue;
    if ((m = MESSAGE_RE.exec(line))) {
      const from = ensure(m[1]).id, to = ensure(m[4]).id;
      steps.push({ type: 'message', from, to, arrow: m[2], text: clean(m[5]) });
    }
  }
  return participants.length ? { participants, steps } : null;
}

function renderSequence(source, { columns = 100, maxLabel = 40 } = {}) {
  const diagram = parseSequence(source);
  if (!diagram) return null;
  const { participants, steps } = diagram;
  const index = new Map(participants.map((p, i) => [p.id, i]));
  const boxW = participants.map((p) => stringWidth(truncate(p.label, maxLabel)) + 4);
  // Minimum distance between neighbouring lifelines.
  const need = participants.map((_, i) => (i === 0 ? 0 : Math.ceil(boxW[i - 1] / 2) + Math.ceil(boxW[i] / 2) + 2));
  for (const s of steps) {
    if (s.type !== 'message') continue;
    const a = index.get(s.from), b = index.get(s.to);
    const width = stringWidth(truncate(s.text, maxLabel)) + 4;
    if (a === b) { if (a + 1 < participants.length) need[a + 1] = Math.max(need[a + 1], width + 4); continue; }
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const per = Math.ceil(width / (hi - lo));
    for (let i = lo + 1; i <= hi; i++) need[i] = Math.max(need[i], per);
  }
  const cx = [];
  participants.forEach((_, i) => { cx[i] = i === 0 ? Math.floor(boxW[0] / 2) : cx[i - 1] + need[i]; });
  const canvas = new Canvas();
  const header = (y) => participants.forEach((p, i) => { const label = truncate(p.label, maxLabel); drawBox(canvas, cx[i] - Math.floor(boxW[i] / 2), y, boxW[i], label, p.actor ? 'round' : 'box'); });
  header(0);
  let y = 3;
  const lifelineStart = 3;
  const right = Math.max(...participants.map((_, i) => cx[i] + Math.ceil(boxW[i] / 2)));
  const rows = [];
  for (const s of steps) {
    if (s.type === 'message') {
      const a = index.get(s.from), b = index.get(s.to);
      const label = truncate(s.text, maxLabel);
      const dashed = s.arrow.startsWith('--');
      const head = s.arrow.endsWith('x') ? '×' : s.arrow.endsWith(')') ? '›' : s.arrow.includes('>>') ? (b >= a ? '▶' : '◀') : (b >= a ? '>' : '<');
      if (a === b) {
        canvas.text(cx[a] + 2, y, label); y++;
        rows.push(() => {});
        canvas.text(cx[a] + 1, y, '──┐'); canvas.text(cx[a] + 1, y + 1, '◀─┘');
        y += 2;
        continue;
      }
      const lo = Math.min(cx[a], cx[b]), hi = Math.max(cx[a], cx[b]);
      canvas.text(lo + Math.max(1, Math.floor((hi - lo - stringWidth(label)) / 2)), y, label);
      y++;
      const line = (dashed ? '╌' : '─').repeat(Math.max(0, hi - lo - 2));
      canvas.text(lo + 1, y, b > a ? line + head : head + line);
      y++;
    } else if (s.type === 'note') {
      const ids = s.ids.map((id) => index.get(id));
      const text = truncate(s.text, maxLabel);
      const w = stringWidth(text) + 4;
      let x = s.where === 'right of' ? cx[ids[0]] + 2 : s.where === 'left of' ? cx[ids[0]] - w - 1 : Math.floor((cx[Math.min(...ids)] + cx[Math.max(...ids)]) / 2 - w / 2);
      x = Math.max(0, x);
      canvas.text(x, y, '┌' + '┄'.repeat(w - 2) + '┐');
      canvas.text(x, y + 1, '┆ ' + text + ' ┆');
      canvas.text(x, y + 2, '└' + '┄'.repeat(w - 2) + '┘');
      y += 3;
    } else if (s.type === 'block' || s.type === 'divider') {
      const title = ' ' + s.kind + (s.label ? ' ' + truncate(s.label, maxLabel) : '') + ' ';
      canvas.text(0, y, '┄┄' + title + '┄'.repeat(Math.max(2, right - stringWidth(title) - 2)));
      y++;
    } else if (s.type === 'end') {
      canvas.text(0, y, '┄'.repeat(Math.max(4, right)));
      y++;
    }
  }
  // Lifelines go under everything; text already placed wins over the line mask.
  participants.forEach((_, i) => canvas.vline(cx[i], lifelineStart - 1, y));
  participants.forEach((_, i) => canvas.put(cx[i], lifelineStart - 1, '┬'));
  header(y + 1);
  const text = canvas.toString();
  if (text.split('\n').some((row) => stringWidth(row) > columns)) {
    return steps.filter((s) => s.type === 'message').map((s) => byId.get(s.from).label + (s.arrow.startsWith('--') ? ' ⇢ ' : ' → ') + byId.get(s.to).label + ': ' + s.text).join('\n');
  }
  return text;
}

// beautiful-mermaid is ESM with an import-only export map; require() of its
// entry file (Node 22.12+ loads synchronous ESM this way) keeps renderMermaid
// synchronous for the Markdown renderer. About 300 ms, once, on first use.
const require = createRequire(import.meta.url);
let beautiful;
function beautifulMermaid() {
  if (beautiful === undefined) {
    try { beautiful = require(fileURLToPath(import.meta.resolve('beautiful-mermaid'))); } catch { beautiful = null; }
  }
  return beautiful;
}

// ER diagrams are left out: beautiful-mermaid 1.1.3 draws three or more
// entities with crossed, detached connectors.
const BEAUTIFUL_TYPES = /^(?:stateDiagram(?:-v2)?|classDiagram|xychart(?:-beta)?)\b/;

function renderWithBeautifulMermaid(source, options) {
  // Its layout counts characters, not terminal columns, so wide (CJK, emoji)
  // labels would break the boxes; show the source for those instead.
  const text = String(source || '');
  if (stringWidth(text.replace(/\n/g, '')) !== [...text.replace(/\n/g, '')].length) return null;
  const lib = beautifulMermaid();
  if (!lib || typeof lib.renderMermaidASCII !== 'function') return null;
  const drawn = String(lib.renderMermaidASCII(text, { colorMode: 'none' }) || '');
  const rows = drawn.split('\n').map((row) => row.replace(/\s+$/, ''));
  while (rows.length && !rows[rows.length - 1]) rows.pop();
  while (rows.length && !rows[0]) rows.shift();
  if (!rows.length) return null;
  const columns = Number(options.columns) || Infinity;
  if (rows.some((row) => stringWidth(row) > columns)) return null;
  return rows.join('\n');
}

export function renderMermaid(source, options = {}) {
  const first = String(source || '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('%%')) || '';
  try {
    if (/^(flowchart|graph)\b/i.test(first)) return renderFlowchart(source, options);
    if (/^sequenceDiagram\b/.test(first)) return renderSequence(source, options);
    if (BEAUTIFUL_TYPES.test(first)) return renderWithBeautifulMermaid(source, options);
  } catch { return null; }
  return null;
}
