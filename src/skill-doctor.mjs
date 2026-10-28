// /skill-doctor (Claude Code): each skill's context cost and how often it was used, so you
// can turn off the ones that cost context without earning it. "Off" means a
// Skill(name) deny rule, which also drops the skill from the system prompt listing.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';
import { listAvailableSkills, loadSkillText } from './tools.mjs';

const tokens = (text) => Math.ceil(String(text || '').length / 4);
const EXTERNAL = ['global-extension', 'project-extension', 'portable-workspace', 'global-portable'];

// Names matched by Skill(...) deny rules; "*" globs are supported.
export function skillDenied(name, deny = []) {
  return (deny || []).some((rule) => {
    const match = /^(?:Skill|load_skill)\((.+)\)$/i.exec(String(rule).trim());
    if (!match) return false;
    const pattern = match[1].trim().replace(/:\*$/, '*');
    if (pattern === '*') return true;
    if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
    return name === pattern;
  });
}

async function usage(env, days) {
  const counts = new Map();
  const last = new Map();
  const since = Date.now() - days * 86400000;
  const base = path.join(getConfigDirectory(env), 'sessions');
  let dirs = [];
  try { dirs = await readdir(base, { withFileTypes: true }); } catch { return { counts, last }; }
  const files = [];
  for (const dir of dirs) {
    if (dir.isFile() && dir.name.endsWith('.json')) files.push(path.join(base, dir.name));
    if (!dir.isDirectory()) continue;
    try { for (const name of await readdir(path.join(base, dir.name))) if (name.endsWith('.json')) files.push(path.join(base, dir.name, name)); } catch {}
  }
  for (const file of files.slice(-2000)) {
    let data;
    try { data = JSON.parse(await readFile(file, 'utf8')); } catch { continue; }
    const when = Date.parse(data.updatedAt || data.createdAt || '') || 0;
    if (when && when < since) continue;
    for (const message of data.messages || []) {
      const names = [];
      for (const call of message.tool_calls || []) {
        if (call.function && call.function.name === 'load_skill') { try { names.push(JSON.parse(call.function.arguments || '{}').name); } catch {} }
      }
      if (message.role === 'user' && typeof message.content === 'string') { const slash = /^\/([\w:.-]+)/.exec(message.content); if (slash) names.push(slash[1]); }
      for (const name of names.filter(Boolean)) { counts.set(name, (counts.get(name) || 0) + 1); last.set(name, Math.max(last.get(name) || 0, when)); }
    }
  }
  return { counts, last };
}

export async function skillDoctor(root, { env = process.env, settings = null, days = 30 } = {}) {
  const deny = (settings && settings.permissions && settings.permissions.deny) || [];
  const skills = await listAvailableSkills(root, { env });
  const { counts, last } = await usage(env, days);
  const rows = [];
  for (const skill of skills) {
    const listing = tokens('- ' + skill.name + ' [' + (EXTERNAL.includes(skill.source) ? 'EXTERNAL UNTRUSTED PROMPT' : skill.source) + ']: ' + skill.description);
    let body = 0;
    try { body = tokens((await loadSkillText(root, skill.name, { env })).content); } catch {}
    rows.push({ name: skill.name, source: skill.source, listing, body, uses: counts.get(skill.name) || 0, lastUsed: last.get(skill.name) || 0, off: skillDenied(skill.name, deny) });
  }
  rows.sort((a, b) => a.uses - b.uses || b.listing - a.listing);
  return { rows, days, listingTotal: rows.filter((row) => !row.off).reduce((sum, row) => sum + row.listing, 0) };
}

export function skillDoctorText(report) {
  if (!report.rows.length) return 'No skills are installed.';
  const lines = ['Skill                          Source            Listing  Body    Uses (' + report.days + 'd)  Status', ''];
  for (const row of report.rows) {
    lines.push(row.name.slice(0, 30).padEnd(31) + String(row.source).slice(0, 17).padEnd(18) + ('~' + row.listing).padEnd(9) + ('~' + row.body).padEnd(8) + String(row.uses).padEnd(11) + (row.off ? 'off' : row.uses ? 'on' : 'on, unused'));
  }
  const unused = report.rows.filter((row) => !row.off && !row.uses);
  lines.push('', 'Always-loaded skill listing: ~' + report.listingTotal + ' tokens per request. Bodies load only when a skill is used.');
  if (unused.length) {
    const save = unused.reduce((sum, row) => sum + row.listing, 0);
    lines.push(unused.length + ' skill(s) were not used in ' + report.days + ' days (~' + save + ' tokens). To turn one off, add a deny rule such as "Skill(' + unused[0].name + ')" to permissions.deny in settings.');
  }
  return lines.join('\n');
}
