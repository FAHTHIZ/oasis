// Control room sheet: every agent on this computer, their screens and
// browsers, recent history, spend and the machine's load. Refreshes every few
// seconds while open. The view model lives in app/core/control-room.mjs.

import { controlRoomKpis, controlRoomAgents, controlRoomEnvironments, controlRoomHistory, controlRoomSessions, controlRoomTrackRecord } from './core/control-room.mjs';

const REFRESH_MS = 3000;
const state = { deps: null, timer: 0, busy: false };
const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function item(row, extra) {
  const li = el('li', 'run-item cr-row ' + row.tone);
  const dot = el('span', 'run-dot');
  dot.setAttribute('aria-hidden', 'true');
  const text = el('div', 'run-text');
  text.append(el('strong', '', row.title));
  if (row.meta || row.detail) text.append(el('span', 'run-meta', row.meta || row.detail));
  if (row.recent) text.append(el('span', 'run-meta cr-recent', 'Recent tools: ' + row.recent));
  li.append(dot, text);
  if (extra) li.append(extra);
  return li;
}

function section(listId, labelId, rows, render, emptyText) {
  const list = $(listId);
  list.replaceChildren(...rows.map(render));
  const empty = $(listId + 'Empty');
  if (empty) { empty.hidden = rows.length > 0; empty.textContent = emptyText; }
  if (labelId) $(labelId).hidden = false;
}

async function stop(row, button) {
  button.disabled = true;
  try {
    await state.deps.api('/api/control-room/stop', { method: 'POST', body: { sessionId: row.sessionId, agentId: row.agentId } });
    state.deps.toast('Stopping ' + row.agentId + '. Its screen and browser close too.');
  } catch (error) { state.deps.toast(error && error.message || 'Could not stop that agent.'); button.disabled = false; }
  void refresh();
}

function render(snapshot) {
  const now = Date.parse(snapshot.updatedAt) || Date.now();
  $('controlRoomKpis').replaceChildren(...controlRoomKpis(snapshot).map((kpi) => {
    const card = el('div', 'cr-kpi ' + kpi.tone);
    card.append(el('span', 'cr-kpi-label', kpi.label), el('strong', 'cr-kpi-value', kpi.value), el('span', 'cr-kpi-detail', kpi.detail));
    return card;
  }));
  section('controlRoomAgents', null, controlRoomAgents(snapshot, { now }), (row) => {
    let button = null;
    if (row.stoppable) {
      button = el('button', 'btn small ghost', 'Stop');
      button.type = 'button';
      button.setAttribute('aria-label', 'Stop ' + row.title);
      button.addEventListener('click', () => stop(row, button));
    }
    const li = item({ ...row, meta: [row.status, row.meta, row.where].filter(Boolean).join(' · ') }, button);
    if (row.depth > 1) li.style.marginLeft = Math.min(4, row.depth - 1) * 16 + 'px';
    return li;
  }, 'No agents in the last ' + (snapshot.summary.hours || 24) + ' hours. Subagents, background agents and teams appear here as they run, from the web app, the terminal and chat gateways alike.');
  section('controlRoomEnvironments', null, controlRoomEnvironments(snapshot), (row) => item({ ...row, detail: [row.kind, row.detail].filter(Boolean).join(' · ') }),
    'No virtual screens or browsers are open. A subagent started with environment "desktop" gets its own screen and browser.');
  section('controlRoomHistory', null, controlRoomHistory(snapshot, { now }), (row) => item({ title: row.text, meta: row.when, tone: row.tone }), 'Nothing yet.');
  section('controlRoomSessions', null, controlRoomSessions(snapshot, { now }), (row) => item({ ...row, tone: 'idle' }), 'No sessions with agents yet.');
  section('controlRoomTrackRecord', null, controlRoomTrackRecord(snapshot, { now }), (row) => item(row), 'No finished subagent runs yet. Each one adds to the track record of its agent type and model.');
  const r = snapshot.resources || {};
  $('controlRoomMachine').textContent = [r.cpus + ' CPUs' + (r.cpuModel ? ' (' + r.cpuModel + ')' : ''), 'load ' + (r.loadAverage || []).join(' / '), 'OASIS server ' + Math.round((r.processRss || 0) / 1024 ** 2) + ' MB', r.platform + ' ' + r.arch].join(' · ');
  $('controlRoomLedgerNote').hidden = snapshot.ledger.available !== false;
  $('controlRoomUpdated').textContent = 'Updated ' + new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function refresh() {
  if (state.busy || $('controlRoomSheet').hidden) return;
  state.busy = true;
  try { render(await state.deps.api('/api/control-room')); $('controlRoomError').hidden = true; }
  catch (error) { $('controlRoomError').hidden = false; $('controlRoomError').textContent = 'Could not load the control room: ' + (error && error.message || error); }
  finally { state.busy = false; }
}

function schedule() {
  clearTimeout(state.timer);
  if ($('controlRoomSheet').hidden) return;
  state.timer = setTimeout(async () => { await refresh(); schedule(); }, REFRESH_MS);
}

/** deps: { api(path, options), toast(text), openSheet(id), available(): boolean } */
export function initControlRoom(deps) {
  state.deps = deps;
  // Stop polling as soon as the sheet closes, however it closes.
  new MutationObserver(() => { if ($('controlRoomSheet').hidden) clearTimeout(state.timer); })
    .observe($('controlRoomSheet'), { attributes: true, attributeFilter: ['hidden'] });
}

export async function openControlRoom() {
  if (!state.deps) return;
  if (!state.deps.available()) { state.deps.toast('The control room needs OASIS running on a computer (oasis web).'); return; }
  state.deps.openSheet('controlRoomSheet');
  await refresh();
  schedule();
}
