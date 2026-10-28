// /insights and `oasis insights`: an HTML report analyzing recent sessions on this machine
// (like Claude Code's /insights): project areas, tool usage, interaction patterns and
// friction points. Everything is computed locally from saved sessions; an optional model
// pass adds a short narrative when a session is available.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';

const MAX_FILES = 2000;
const CORRECTION = /\b(no[,.! ]|not what i|that's wrong|thats wrong|wrong|undo|revert|stop|don't|do not|instead|actually)\b/i;
const FILE_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'notebook_edit', 'delete_file']);

function parseArgs(raw) { try { return JSON.parse(raw || '{}'); } catch { return {}; } }
function bump(map, key, by = 1) { if (key) map.set(key, (map.get(key) || 0) + by); }
const top = (map, n = 10) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function collectInsights(options = {}) {
  const env = options.env || process.env;
  const days = options.days || 30;
  const since = Date.now() - days * 86400000;
  const base = path.join(getConfigDirectory(env), 'sessions');
  const stats = {
    days, sessions: 0, userTurns: 0, assistantTurns: 0, toolCalls: 0, toolErrors: 0, denials: 0, corrections: 0, interrupted: 0,
    tools: new Map(), toolErrorsBy: new Map(), projects: new Map(), models: new Map(), files: new Map(), extensions: new Map(),
    commands: new Map(), byDay: new Map(), hours: new Array(24).fill(0), longest: [], examples: { corrections: [], errors: [] }
  };
  let dirs = [];
  try { dirs = await readdir(base, { withFileTypes: true }); } catch { return stats; }
  let scanned = 0;
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    let names = [];
    try { names = await readdir(path.join(base, dir.name)); } catch { continue; }
    for (const name of names) {
      if (!/\.json$/.test(name) || ++scanned > MAX_FILES) continue;
      let data;
      try { data = JSON.parse(await readFile(path.join(base, dir.name, name), 'utf8')); } catch { continue; }
      if (!data || data.schemaVersion !== 1 || !Array.isArray(data.messages)) continue;
      const updated = Date.parse(data.updatedAt || '');
      if (!Number.isFinite(updated) || updated < since) continue;
      stats.sessions++;
      const project = path.basename(data.workspaceRoot || '') || '(unknown)';
      bump(stats.projects, project);
      bump(stats.models, data.provider && data.provider.model);
      const day = new Date(updated).toISOString().slice(0, 10);
      bump(stats.byDay, day);
      stats.hours[new Date(updated).getHours()]++;
      let turns = 0;
      const pending = new Map();
      for (const message of data.messages) {
        if (!message) continue;
        if (message.role === 'user' && typeof message.content === 'string') {
          const text = message.content.replace(/<[a-z-]+>[\s\S]*?<\/[a-z-]+>/g, ' ').trim();
          if (!text) continue;
          stats.userTurns++; turns++;
          const slash = /^\/([a-z][\w:-]*)/i.exec(text);
          if (slash) bump(stats.commands, '/' + slash[1].toLowerCase());
          if (turns > 1 && CORRECTION.test(text.slice(0, 200))) {
            stats.corrections++;
            if (stats.examples.corrections.length < 8) stats.examples.corrections.push({ project, text: text.slice(0, 160) });
          }
          if (/interrupted|\[request interrupted/i.test(text)) stats.interrupted++;
        } else if (message.role === 'assistant') {
          stats.assistantTurns++;
          for (const call of message.tool_calls || []) {
            const fn = call.function || {};
            stats.toolCalls++;
            bump(stats.tools, fn.name);
            pending.set(call.id, fn.name);
            if (FILE_TOOLS.has(fn.name)) {
              const args = parseArgs(fn.arguments);
              const file = args.path || args.file_path || args.notebook_path;
              if (file) { bump(stats.files, project + ': ' + file); bump(stats.extensions, path.extname(String(file)).toLowerCase() || '(none)'); }
            }
          }
        } else if (message.role === 'tool') {
          const content = String(message.content || '');
          const tool = message.name || pending.get(message.tool_call_id) || 'tool';
          if (/^\{"error"|"error":|denied|not allowed|blocked by/i.test(content.slice(0, 300))) {
            if (/denied|not allowed|blocked by|declined/i.test(content.slice(0, 300))) stats.denials++;
            else { stats.toolErrors++; bump(stats.toolErrorsBy, tool); if (stats.examples.errors.length < 8) stats.examples.errors.push({ project, tool, text: content.slice(0, 160) }); }
          }
        }
      }
      stats.longest.push({ project, turns, title: (data.name || (data.messages.find((m) => m && m.role === 'user' && typeof m.content === 'string') || {}).content || '').replace(/\s+/g, ' ').slice(0, 80), day });
    }
  }
  stats.longest = stats.longest.sort((a, b) => b.turns - a.turns).slice(0, 8);
  return stats;
}

export function insightsSummaryText(stats) {
  if (!stats.sessions) return 'No saved sessions in the last ' + stats.days + ' days.';
  const pct = (a, b) => b ? Math.round((a / b) * 100) + '%' : '0%';
  return [
    stats.sessions + ' sessions, ' + stats.userTurns + ' prompts, ' + stats.toolCalls + ' tool calls in the last ' + stats.days + ' days.',
    'Top projects: ' + top(stats.projects, 5).map(([k, v]) => k + ' (' + v + ')').join(', ') + '.',
    'Top tools: ' + top(stats.tools, 6).map(([k, v]) => k + ' ' + v).join(', ') + '.',
    'Friction: ' + stats.toolErrors + ' tool errors (' + pct(stats.toolErrors, stats.toolCalls) + '), ' + stats.denials + ' denials, ' + stats.corrections + ' prompts that look like corrections.'
  ].join('\n');
}

function bars(entries, unit = '') {
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return entries.map(([k, v]) => '<div class="bar"><span class="label" title="' + esc(k) + '">' + esc(k) + '</span><span class="track"><span class="fill" style="width:' + Math.round((v / max) * 100) + '%"></span></span><span class="num">' + v + unit + '</span></div>').join('') || '<p class="muted">None yet.</p>';
}

export function renderInsightsHtml(stats, narrative = '') {
  const tips = [];
  if (stats.toolCalls && stats.toolErrors / stats.toolCalls > 0.1) tips.push('More than 10% of tool calls failed. The tools failing most are listed below; a CLAUDE.md note on how to build and test this project often fixes repeated command errors.');
  if (stats.denials > 5) tips.push(stats.denials + ' tool calls were denied. If you approve the same commands often, add allow rules with /permissions or oasis permissions add allow "Bash(npm test)".');
  if (stats.corrections > Math.max(3, stats.userTurns * 0.1)) tips.push('Many follow-up prompts read like corrections. Plan mode (/plan) or a short spec before large changes can cut down rework.');
  if ((stats.tools.get('read_file') || 0) > 4 * ((stats.tools.get('grep') || 0) + (stats.tools.get('search') || 0) + 1)) tips.push('Most exploration is file-by-file reading. Asking the agent to search first (or using the explore subagent) is usually faster on big repositories.');
  if (!tips.length) tips.push('No major friction patterns detected. Nice.');
  const days = [...stats.byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Oasis insights</title>
<style>
:root{--bg:#0f1115;--card:#171a21;--text:#e6e8ee;--muted:#9aa3b2;--accent:#5eb8ff;--warn:#f0b35a}
@media (prefers-color-scheme:light){:root{--bg:#f6f7f9;--card:#fff;--text:#1b1f27;--muted:#5d6675;--accent:#0a6cc2;--warn:#a35d00}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1000px;margin:0 auto;padding:32px 20px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:17px;margin:0 0 12px}
.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-top:16px}
.card{background:var(--card);border-radius:12px;padding:18px}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-top:20px}
.kpi{background:var(--card);border-radius:12px;padding:14px}.kpi b{display:block;font-size:24px}
.bar{display:grid;grid-template-columns:minmax(90px,40%) 1fr 48px;gap:8px;align-items:center;margin:4px 0;font-size:13px}
.label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.track{background:rgba(127,127,127,.18);border-radius:4px;height:8px}
.fill{display:block;height:8px;border-radius:4px;background:var(--accent)}.num{text-align:right;color:var(--muted)}
li{margin:6px 0}.tip{border-left:3px solid var(--warn);padding-left:10px}code{font-size:12px}
</style></head><body><main>
<h1>Oasis insights</h1><p class="muted">Last ${stats.days} days on this machine, generated ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC. Computed locally from saved sessions.</p>
<div class="kpis">
<div class="kpi"><b>${stats.sessions}</b><span class="muted">sessions</span></div>
<div class="kpi"><b>${stats.userTurns}</b><span class="muted">prompts</span></div>
<div class="kpi"><b>${stats.toolCalls}</b><span class="muted">tool calls</span></div>
<div class="kpi"><b>${stats.toolErrors}</b><span class="muted">tool errors</span></div>
<div class="kpi"><b>${stats.denials}</b><span class="muted">denied calls</span></div>
<div class="kpi"><b>${stats.corrections}</b><span class="muted">correction-like prompts</span></div>
</div>
${narrative ? '<div class="card" style="margin-top:16px"><h2>Summary</h2>' + narrative.split(/\n{2,}/).map((p) => '<p>' + esc(p) + '</p>').join('') + '</div>' : ''}
<div class="card" style="margin-top:16px"><h2>Suggestions</h2><ul>${tips.map((t) => '<li class="tip">' + esc(t) + '</li>').join('')}</ul></div>
<div class="grid">
<div class="card"><h2>Project areas</h2>${bars(top(stats.projects))}</div>
<div class="card"><h2>Tools used</h2>${bars(top(stats.tools, 12))}</div>
<div class="card"><h2>File types changed</h2>${bars(top(stats.extensions))}</div>
<div class="card"><h2>Most-edited files</h2>${bars(top(stats.files, 8))}</div>
<div class="card"><h2>Slash commands</h2>${bars(top(stats.commands))}</div>
<div class="card"><h2>Models</h2>${bars(top(stats.models))}</div>
<div class="card"><h2>Activity by day</h2>${bars(days.slice(-14))}</div>
<div class="card"><h2>Activity by hour</h2>${bars(stats.hours.map((v, h) => [String(h).padStart(2, '0') + ':00', v]).filter(([, v]) => v))}</div>
<div class="card"><h2>Failing tools</h2>${bars(top(stats.toolErrorsBy))}</div>
<div class="card"><h2>Longest sessions</h2><ul>${stats.longest.map((s) => '<li>' + esc(s.title || '(untitled)') + ' <span class="muted">' + esc(s.project) + ', ' + s.turns + ' prompts, ' + s.day + '</span></li>').join('') || '<p class="muted">None yet.</p>'}</ul></div>
<div class="card"><h2>Friction examples</h2><ul>${[...stats.examples.errors.map((e) => '<li><code>' + esc(e.tool) + '</code> ' + esc(e.text) + ' <span class="muted">' + esc(e.project) + '</span></li>'), ...stats.examples.corrections.map((c) => '<li>“' + esc(c.text) + '” <span class="muted">' + esc(c.project) + '</span></li>')].join('') || '<p class="muted">None.</p>'}</ul></div>
</div></main></body></html>
`;
}

export async function writeInsightsReport(options = {}) {
  const env = options.env || process.env;
  const stats = await collectInsights(options);
  let narrative = '';
  if (options.narrate && stats.sessions) { try { narrative = await options.narrate(insightsSummaryText(stats)); } catch {} }
  const dir = path.join(getConfigDirectory(env), 'insights');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'insights-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.html');
  await writeFile(file, renderInsightsHtml(stats, narrative), { mode: 0o600 });
  return { file, stats };
}
