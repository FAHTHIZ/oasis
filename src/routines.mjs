// Durable scheduled jobs ("routines"): prompts and scripts that run on a schedule
// whether or not a terminal is open. In-session /schedule jobs end with the
// session; routines persist in <oasis config>/schedules and are run by
// `oasis schedule daemon` (or `oasis schedule tick` from a system crontab).
//
// Design notes (compared with Hermes Agent's cron, which this follows closely):
// - Every fire runs in a fresh detached background session (src/background-sessions.mjs),
//   so a routine gets the same tools, permissions, approvals and logs as `oasis --bg`.
// - State lives in files. A daemon restart reconciles runs it started earlier
//   from the background registry instead of firing them again.
// - Schedules: 5-field cron (croner, optional per-job timezone), "every 30m|2h|1d",
//   "in 30m" (one-shot) or an ISO timestamp (one-shot).
// - A missed cron slot runs late only inside a catch-up window: half the period,
//   clamped to 2 minutes .. 2 hours, or the job's graceMinutes (0 = never).
// - Script jobs (kind "script") run a shell command with no model call.
// - Output that starts with [SILENT] is recorded but not delivered.
// - A misconfigured model provider marks the job blocked_config once and spends no tokens.
// - Scheduled runs cannot create more routines (OASIS_SCHEDULED_RUN is set).
import { Cron } from 'croner';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getConfigDirectory, loadConfig } from './config.mjs';
import { atomicWriteFile } from './atomic-write.mjs';
import { redactSecrets } from './auto-memory.mjs';
import { chunkText } from './gateway-core.mjs';

const MAX_JOBS = 200;
const MAX_PROMPT = 20_000;
const MAX_OUTPUT = 60_000;
const LOCK_STALE_MS = 2 * 60_000;
const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk'];

export function schedulesDirectory(env = process.env) {
  return path.join(getConfigDirectory(env), 'schedules');
}
const jobsFile = (env) => path.join(schedulesDirectory(env), 'jobs.json');
const runsFile = (id, env) => path.join(schedulesDirectory(env), 'runs', id + '.jsonl');
const outputDir = (id, env) => path.join(schedulesDirectory(env), 'output', id);

function parseDuration(text) {
  const match = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/i.exec(String(text).trim());
  if (!match) return null;
  const unit = match[2][0].toLowerCase();
  const ms = Number(match[1]) * UNITS[unit];
  return ms > 0 ? ms : null;
}

// Returns { type: 'cron'|'interval'|'once', ... } or throws a readable error.
export function parseSchedule(input, { now = new Date(), timezone } = {}) {
  const text = String(input || '').trim();
  if (!text) throw new Error('A routine needs a schedule, for example "0 9 * * 1-5", "every 2h", "in 30m" or 2026-12-01T09:00.');
  const every = /^every\s+(.+)$/i.exec(text);
  if (every) {
    const ms = parseDuration(every[1]);
    if (!ms) throw new Error('Could not read the interval in "' + text + '". Use every 30m, every 2h or every 1d.');
    if (ms < 60_000) throw new Error('The shortest interval is every 1m.');
    return { type: 'interval', everyMs: ms, display: text };
  }
  const inMatch = /^in\s+(.+)$/i.exec(text);
  if (inMatch) {
    const ms = parseDuration(inMatch[1]);
    if (!ms) throw new Error('Could not read the delay in "' + text + '". Use in 30m, in 2h or in 1d.');
    return { type: 'once', at: new Date(now.getTime() + ms).toISOString(), display: text };
  }
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(text)) {
    const at = new Date(text.replace(' ', 'T'));
    if (Number.isNaN(at.getTime())) throw new Error('Could not read the date ' + text + '.');
    return { type: 'once', at: at.toISOString(), display: text };
  }
  try {
    const cron = new Cron(text, { paused: true, ...(timezone ? { timezone } : {}) });
    if (!cron.nextRun(now)) throw new Error('never runs');
    return { type: 'cron', expr: text, display: text };
  } catch (error) {
    throw new Error('Could not read the schedule "' + text + '": ' + (error.message || error) + '. Use a 5-field cron expression, every 2h, in 30m or an ISO date.');
  }
}

function cronOf(job) { return new Cron(job.schedule.expr, { paused: true, ...(job.timezone ? { timezone: job.timezone } : {}) }); }

// The first occurrence strictly after `after`.
export function nextOccurrence(job, after = new Date()) {
  const s = job.schedule;
  if (s.type === 'once') return new Date(s.at) > after || !job.lastRunAt ? s.at : null;
  if (s.type === 'interval') return new Date(after.getTime() + s.everyMs).toISOString();
  const next = cronOf(job).nextRun(after);
  return next ? next.toISOString() : null;
}

// How late a missed cron slot may still run.
export function catchUpWindowMs(job) {
  if (Number.isFinite(job.graceMinutes)) return Math.max(0, job.graceMinutes) * 60_000;
  if (job.schedule.type !== 'cron') return Infinity;
  const runs = cronOf(job).nextRuns(2, new Date(job.nextRunAt || Date.now()));
  const period = runs.length === 2 ? runs[1] - runs[0] : 2 * UNITS.h;
  return Math.min(2 * UNITS.h, Math.max(2 * 60_000, period / 2));
}

// Delivery targets: local (default), telegram:CHAT_ID, slack:CHANNEL, discord:CHANNEL_ID, webhook:URL.
export function parseDeliver(value) {
  const text = String(value || 'local').trim();
  if (text === 'local') return 'local';
  const match = /^(telegram|slack|discord|webhook):(.+)$/.exec(text);
  if (!match) throw new Error('Unknown delivery target ' + text + '. Use local, telegram:CHAT_ID, slack:CHANNEL, discord:CHANNEL_ID or webhook:https://...');
  if (match[1] === 'webhook') {
    let url;
    try { url = new URL(match[2]); } catch { throw new Error('webhook: needs a full URL.'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('A webhook target must use https:// (http:// only for localhost).');
  }
  return text;
}

// --- store with a cross-process lock -------------------------------------

async function withLock(env, fn) {
  const dir = schedulesDirectory(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, 'store.lock');
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { await mkdir(lock); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS) { await rm(lock, { recursive: true, force: true }); continue; } } catch {}
      if (Date.now() > deadline) throw new Error('The routine store is locked by another OASIS process (' + lock + ').');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try { return await fn(); } finally { await rm(lock, { recursive: true, force: true }).catch(() => {}); }
}

export async function readJobs(env = process.env) {
  try {
    const data = JSON.parse(await readFile(jobsFile(env), 'utf8'));
    return Array.isArray(data.jobs) ? data.jobs : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('Could not read ' + jobsFile(env) + ': ' + error.message);
  }
}

async function writeJobs(jobs, env) {
  await atomicWriteFile(jobsFile(env), JSON.stringify({ version: 1, jobs }, null, 2) + '\n', { mode: 0o600 });
}

async function mutate(env, fn) {
  return withLock(env, async () => {
    const jobs = await readJobs(env);
    const result = await fn(jobs);
    await writeJobs(jobs, env);
    return result;
  });
}

// Accepts an exact id, an id prefix, or a case-insensitive name. Ambiguous names are refused.
export function findJob(jobs, ref) {
  const text = String(ref || '').trim();
  if (!text) throw new Error('Give a routine id or name. oasis schedule list shows them.');
  const exact = jobs.find((job) => job.id === text || job.id === 'rt-' + text);
  if (exact) return exact;
  const byPrefix = jobs.filter((job) => job.id.startsWith(text) || job.id.startsWith('rt-' + text));
  if (byPrefix.length === 1) return byPrefix[0];
  const byName = jobs.filter((job) => job.name && job.name.toLowerCase() === text.toLowerCase());
  if (byName.length === 1) return byName[0];
  const many = byName.length > 1 ? byName : byPrefix;
  if (many.length > 1) throw new Error(text + ' matches several routines: ' + many.map((job) => job.id).join(', ') + '. Use the id.');
  throw new Error('No routine matches ' + text + '. oasis schedule list shows them.');
}

function guardScheduledRun(env) {
  if (/^(1|true)$/i.test(String(env.OASIS_SCHEDULED_RUN || ''))) throw new Error('A scheduled run cannot create or change routines.');
}

function normalizeFields(fields, existing = {}, now = new Date()) {
  const job = { ...existing };
  if (fields.name !== undefined) job.name = String(fields.name || '').trim().slice(0, 80) || undefined;
  if (fields.timezone !== undefined) {
    const tz = String(fields.timezone || '').trim();
    if (tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { throw new Error('Unknown time zone ' + tz + '.'); } job.timezone = tz; } else delete job.timezone;
  }
  if (fields.kind !== undefined) {
    if (!['agent', 'script'].includes(fields.kind)) throw new Error('kind must be agent or script.');
    job.kind = fields.kind;
  }
  job.kind = job.kind || 'agent';
  if (fields.prompt !== undefined) {
    const prompt = String(fields.prompt || '').trim();
    if (!prompt) throw new Error(job.kind === 'script' ? 'A script routine needs a command.' : 'A routine needs a prompt.');
    if (prompt.length > MAX_PROMPT) throw new Error('The prompt is longer than ' + MAX_PROMPT + ' characters.');
    job.prompt = prompt;
  }
  if (!job.prompt) throw new Error(job.kind === 'script' ? 'A script routine needs a command.' : 'A routine needs a prompt.');
  if (fields.workdir !== undefined) {
    const dir = String(fields.workdir || '').trim();
    if (dir && !path.isAbsolute(dir)) throw new Error('workdir must be an absolute path.');
    if (dir) job.workdir = dir; else delete job.workdir;
  }
  if (fields.model !== undefined) { const model = String(fields.model || '').trim(); if (model) job.model = model; else delete job.model; }
  if (fields.permissionMode !== undefined) {
    const mode = String(fields.permissionMode || '').trim();
    if (mode && !PERMISSION_MODES.includes(mode)) throw new Error('permission mode must be one of ' + PERMISSION_MODES.join(', ') + '.');
    if (mode) job.permissionMode = mode; else delete job.permissionMode;
  }
  if (fields.skills !== undefined) job.skills = [...new Set((fields.skills || []).map((s) => String(s).trim()).filter((s) => /^[\w.:-]{1,80}$/.test(s)))];
  if (fields.deliver !== undefined) job.deliver = parseDeliver(fields.deliver);
  job.deliver = job.deliver || 'local';
  if (fields.graceMinutes !== undefined) {
    if (fields.graceMinutes === null || fields.graceMinutes === '') delete job.graceMinutes;
    else {
      const grace = Number(fields.graceMinutes);
      if (!Number.isInteger(grace) || grace < 0 || grace > 1440) throw new Error('grace minutes must be a whole number from 0 to 1440.');
      job.graceMinutes = grace;
    }
  }
  if (fields.schedule !== undefined || fields.timezone !== undefined) {
    job.schedule = parseSchedule(fields.schedule !== undefined ? fields.schedule : job.schedule.display, { now, timezone: job.timezone });
    if (job.enabled !== false) job.nextRunAt = job.schedule.type === 'once' ? job.schedule.at : nextOccurrence(job, now);
  }
  return job;
}

export async function createJob(fields = {}, { env = process.env, now = new Date() } = {}) {
  guardScheduledRun(env);
  return mutate(env, (jobs) => {
    if (jobs.length >= MAX_JOBS) throw new Error('There are already ' + MAX_JOBS + ' routines. Remove some first.');
    const id = 'rt-' + randomUUID().replace(/-/g, '').slice(0, 8);
    const paused = Boolean(fields.paused);
    const job = normalizeFields({ ...fields, schedule: fields.schedule ?? '' }, { id, createdAt: now.toISOString(), enabled: !paused, state: paused ? 'paused' : 'scheduled' }, now);
    if (paused) { job.nextRunAt = null; job.pausedReason = String(fields.pausedReason || 'Created paused; awaiting review.'); }
    jobs.push(job);
    return job;
  });
}

export async function editJob(ref, fields = {}, { env = process.env, now = new Date() } = {}) {
  guardScheduledRun(env);
  return mutate(env, (jobs) => {
    const job = findJob(jobs, ref);
    Object.assign(job, normalizeFields(fields, job, now), { updatedAt: now.toISOString() });
    return job;
  });
}

export async function pauseJob(ref, reason = '', { env = process.env, now = new Date() } = {}) {
  guardScheduledRun(env);
  return mutate(env, (jobs) => {
    const job = findJob(jobs, ref);
    Object.assign(job, { enabled: false, state: 'paused', pausedAt: now.toISOString(), pausedReason: String(reason || 'Paused by the user.') });
    return job;
  });
}

// A recurring job whose slot came due while paused keeps that slot, so the next tick
// runs one catch-up fire (inside the window) instead of silently skipping it.
export async function resumeJob(ref, { env = process.env, now = new Date() } = {}) {
  guardScheduledRun(env);
  return mutate(env, (jobs) => {
    const job = findJob(jobs, ref);
    if (job.state === 'completed') throw new Error(job.id + ' already ran its one-time schedule. Edit its schedule to run it again.');
    job.enabled = true; job.state = 'scheduled';
    delete job.pausedAt; delete job.pausedReason;
    if (!job.nextRunAt) job.nextRunAt = job.schedule.type === 'once' ? job.schedule.at : nextOccurrence(job, now);
    if (job.lastStatus === 'blocked_config') job.lastStatus = 'pending';
    return job;
  });
}

export async function removeJob(ref, { env = process.env, stop } = {}) {
  guardScheduledRun(env);
  const job = await mutate(env, (jobs) => {
    const found = findJob(jobs, ref);
    jobs.splice(jobs.indexOf(found), 1);
    return found;
  });
  if (job.activeRun && stop) await stop(job.activeRun.backgroundId, env).catch(() => {});
  if (job.activeRun) await appendRun(job.id, { ...job.activeRun, status: 'cancelled', reason: 'routine removed while running', finishedAt: new Date().toISOString() }, env);
  return job;
}

export async function triggerJob(ref, { env = process.env } = {}) {
  return mutate(env, (jobs) => { const job = findJob(jobs, ref); job.manualRunRequested = true; return job; });
}

async function appendRun(id, record, env) {
  const file = runsFile(id, env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, JSON.stringify(record) + '\n', { mode: 0o600 });
}

export async function listRuns(ref, { env = process.env, limit = 20 } = {}) {
  const job = findJob(await readJobs(env), ref);
  let text = '';
  try { text = await readFile(runsFile(job.id, env), 'utf8'); } catch {}
  const runs = text.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  return { job, runs: runs.slice(-limit) };
}

// --- running -------------------------------------------------------------

function composePrompt(job) {
  const lines = [];
  lines.push('This is a scheduled run of the routine ' + (job.name ? '"' + job.name + '" ' : '') + '(' + job.id + ', schedule ' + job.schedule.display + '). Nobody is watching live; finish the task and end with a short report of what you did and found.');
  if (job.skills && job.skills.length) lines.push('Before starting, load and follow these skills: ' + job.skills.join(', ') + '.');
  lines.push('If there is nothing worth reporting, begin your final answer with [SILENT].');
  lines.push('', job.prompt);
  return lines.join('\n');
}

// Reads the final answer from a stream-json log (agent) or the plain log tail (script).
export function extractRunOutput(logText, kind = 'agent') {
  const text = String(logText || '');
  if (kind === 'script') {
    const exit = /\n?\[exit (-?\d+)[^\]]*\]\s*$/.exec(text);
    return { output: text.replace(/\n?\[exit [^\]]*\]\s*$/, '').trim().slice(-MAX_OUTPUT), isError: exit ? exit[1] !== '0' : false };
  }
  let result = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try { const event = JSON.parse(line); if (event.type === 'result') result = event; } catch {}
  }
  if (!result) return { output: '', isError: true, missing: true };
  return { output: String(result.result || '').slice(-MAX_OUTPUT), isError: Boolean(result.is_error) || result.subtype !== 'success' };
}

async function preflight(job, env) {
  if (job.kind === 'script') return null;
  try {
    const config = await loadConfig({ env });
    if (!config.configured) return 'no usable model credentials for ' + config.baseURL + ' (config ' + config.configPath + ')';
  } catch (error) { return error.message; }
  if (job.workdir) {
    try { if (!(await stat(job.workdir)).isDirectory()) return 'workdir ' + job.workdir + ' is not a folder'; } catch { return 'workdir ' + job.workdir + ' does not exist'; }
  }
  const target = job.deliver || 'local';
  const need = { telegram: 'OASIS_TELEGRAM_BOT_TOKEN', slack: 'OASIS_SLACK_BOT_TOKEN', discord: 'OASIS_DISCORD_BOT_TOKEN' }[target.split(':')[0]];
  if (need && !env[need]) return 'delivery to ' + target + ' needs ' + need;
  return null;
}

export async function deliverOutput(job, text, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const target = job.deliver || 'local';
  if (target === 'local') return { delivered: 'local' };
  const [kind, ...restParts] = target.split(':');
  const dest = restParts.join(':');
  const body = redactSecrets((job.name ? job.name + ' (' + job.id + ')' : job.id) + '\n\n' + text).text;
  const post = async (url, payload, headers = {}) => {
    const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(kind + ' answered HTTP ' + response.status);
    if (kind === 'slack') { const data = await response.json().catch(() => ({})); if (data.ok === false) throw new Error('slack: ' + (data.error || 'rejected')); }
  };
  if (kind === 'telegram') {
    const base = String(env.OASIS_TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
    for (const part of chunkText(body, 4000)) await post(base + '/bot' + env.OASIS_TELEGRAM_BOT_TOKEN + '/sendMessage', { chat_id: dest, text: part, disable_web_page_preview: true });
  } else if (kind === 'slack') {
    const base = String(env.OASIS_SLACK_API_BASE || 'https://slack.com/api').replace(/\/+$/, '');
    for (const part of chunkText(body, 3500)) await post(base + '/chat.postMessage', { channel: dest, text: part, unfurl_links: false }, { authorization: 'Bearer ' + env.OASIS_SLACK_BOT_TOKEN });
  } else if (kind === 'discord') {
    const base = String(env.OASIS_DISCORD_API_BASE || 'https://discord.com/api/v10').replace(/\/+$/, '');
    for (const part of chunkText(body, 1900)) await post(base + '/channels/' + dest + '/messages', { content: part, allowed_mentions: { parse: [] } }, { authorization: 'Bot ' + env.OASIS_DISCORD_BOT_TOKEN });
  } else if (kind === 'webhook') {
    await post(dest, { routine: job.id, name: job.name || null, text: body });
  }
  return { delivered: target };
}

async function launch(job, env, backgrounds, now) {
  const root = job.workdir || env.HOME || process.cwd();
  const childEnv = { ...env, OASIS_SCHEDULED_RUN: '1', OASIS_ROUTINE_ID: job.id };
  const name = 'routine ' + (job.name || job.id);
  const entry = job.kind === 'script'
    ? await backgrounds.startExecJob({ root, command: job.prompt, name, env: childEnv })
    : await backgrounds.startBackgroundSession({ root, prompt: composePrompt(job), name, model: job.model, permissionMode: job.permissionMode, env: childEnv });
  return { fireId: randomUUID(), backgroundId: entry.id, startedAt: now.toISOString(), manual: false };
}

// Finishes runs whose background session has ended: records the result, writes the
// output file and delivers it. Safe to repeat: a run is only finished once.
async function reconcile(job, env, backgrounds, options) {
  const run = job.activeRun;
  let entry;
  try { entry = await backgrounds.readEntry(run.backgroundId, env); } catch { entry = null; }
  if (entry && entry.status === 'running') return false;
  let logText = '';
  if (entry?.logFile) { try { logText = await readFile(entry.logFile, 'utf8'); } catch {} }
  const { output, isError, missing } = extractRunOutput(logText, job.kind);
  const status = !entry ? 'lost' : entry.status === 'stopped' ? 'cancelled' : entry.status === 'interrupted' ? 'interrupted' : (isError || missing || (entry.exitCode && entry.exitCode !== 0)) ? 'failed' : 'ok';
  const finishedAt = (options.now || new Date()).toISOString();
  const silent = /^\s*\[SILENT\]/.test(output);
  const record = { ...run, status, finishedAt, exitCode: entry?.exitCode ?? null, silent };
  if (output) {
    const dir = outputDir(job.id, env);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    record.outputFile = path.join(dir, run.startedAt.replace(/[:.]/g, '-') + '.md');
    await writeFile(record.outputFile, output + '\n', { mode: 0o600 });
  }
  if (status !== 'cancelled' && !silent && (output || status !== 'ok')) {
    const message = status === 'ok' ? output : 'Run ' + status + (output ? ':\n' + output : '.') + '\nLogs: oasis bg logs ' + run.backgroundId;
    try { record.delivery = (await deliverOutput(job, message, { env, fetchImpl: options.fetchImpl })).delivered; } catch (error) { record.deliveryError = error.message; }
  }
  await appendRun(job.id, record, env);
  job.lastStatus = status; job.lastRunAt = run.startedAt; job.lastFinishedAt = finishedAt;
  job.failureStreak = status === 'failed' || status === 'lost' ? (job.failureStreak || 0) + 1 : status === 'ok' ? 0 : job.failureStreak || 0;
  delete job.activeRun;
  if (status === 'interrupted' || status === 'lost') {
    // Never re-run an interrupted fire automatically: it may have had side effects.
    Object.assign(job, { enabled: false, state: 'paused', pausedReason: 'The last run was ' + status + '; review it (oasis bg logs ' + run.backgroundId + ') and resume.' });
  }
  return true;
}

// One scheduler pass. Returns a summary of what happened.
export async function tick(options = {}) {
  const env = options.env || process.env;
  const now = options.now || new Date();
  const backgrounds = options.backgrounds || await import('./background-sessions.mjs');
  const maxParallel = Number(options.maxParallel || env.OASIS_SCHEDULE_MAX_PARALLEL) || 4;
  const summary = { fired: [], finished: [], skipped: [], blocked: [] };
  await mutate(env, async (jobs) => {
    for (const job of jobs) {
      if (job.activeRun && await reconcile(job, env, backgrounds, { ...options, now })) summary.finished.push(job.id);
    }
    let running = jobs.filter((job) => job.activeRun).length;
    for (const job of jobs) {
      const manual = job.manualRunRequested === true;
      const due = job.enabled !== false && job.nextRunAt && new Date(job.nextRunAt) <= now;
      if (!manual && !due) continue;
      if (job.activeRun) { if (due) { summary.skipped.push({ id: job.id, reason: 'previous run still active' }); job.nextRunAt = nextOccurrence(job, now); } continue; }
      if (due && !manual && job.schedule.type === 'cron' && now - new Date(job.nextRunAt) > catchUpWindowMs(job)) {
        await appendRun(job.id, { fireId: randomUUID(), status: 'missed', slot: job.nextRunAt, finishedAt: now.toISOString() }, env);
        summary.skipped.push({ id: job.id, reason: 'missed slot ' + job.nextRunAt + ' is outside the catch-up window' });
        job.nextRunAt = nextOccurrence(job, now);
        continue;
      }
      if (running >= maxParallel) { summary.skipped.push({ id: job.id, reason: 'parallel limit ' + maxParallel }); continue; }
      const problem = await preflight(job, env);
      if (problem) {
        if (job.lastStatus !== 'blocked_config') {
          await appendRun(job.id, { fireId: randomUUID(), status: 'blocked_config', reason: problem, finishedAt: now.toISOString() }, env);
          try { await deliverOutput({ ...job, deliver: job.deliver }, 'Routine blocked before running (no model call was made): ' + problem, { env, fetchImpl: options.fetchImpl }); } catch {}
        }
        job.lastStatus = 'blocked_config'; job.lastProblem = problem;
        summary.blocked.push({ id: job.id, reason: problem });
        if (due) job.nextRunAt = nextOccurrence(job, now);
        delete job.manualRunRequested;
        continue;
      }
      try {
        job.activeRun = { ...(await launch(job, env, backgrounds, now)), manual: manual && !due, slot: due ? job.nextRunAt : null };
        running++;
        summary.fired.push(job.id);
        delete job.lastProblem;
      } catch (error) {
        await appendRun(job.id, { fireId: randomUUID(), status: 'failed', reason: 'could not start: ' + error.message, finishedAt: now.toISOString() }, env);
        job.lastStatus = 'failed';
      }
      delete job.manualRunRequested;
      if (due) {
        if (job.schedule.type === 'once') { job.nextRunAt = null; job.enabled = false; job.state = 'completed'; }
        else job.nextRunAt = nextOccurrence(job, now);
      }
    }
  });
  return summary;
}

export async function cancelRun(ref, { env = process.env, backgrounds } = {}) {
  const job = findJob(await readJobs(env), ref);
  if (!job.activeRun) return { job, cancelled: false };
  const bg = backgrounds || await import('./background-sessions.mjs');
  await bg.stopBackgroundSession(job.activeRun.backgroundId, env);
  return { job, cancelled: true };
}

// pid of a live scheduler for this config folder (other than this process), or 0.
export async function runningDaemonPid(env = process.env) {
  let other = 0;
  try { other = Number((await readFile(path.join(schedulesDirectory(env), 'daemon.pid'), 'utf8')).trim()); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!other || other === process.pid) return 0;
  try { process.kill(other, 0); return other; } catch (error) { return error.code === 'EPERM' ? other : 0; }
}

// `oasis web` and `oasis gateway` run the scheduler in-process (as Hermes' gateway does)
// unless a daemon already owns this config folder or OASIS_ROUTINES=off.
export async function hostScheduler({ env = process.env, intervalMs = 30_000, log = () => {} } = {}) {
  const idle = (reason) => ({ hosted: false, reason, routines: 0, stop: async () => {} });
  if (/^(0|off|false|no)$/i.test(String(env.OASIS_ROUTINES || ''))) return idle('disabled by OASIS_ROUTINES');
  const other = await runningDaemonPid(env);
  if (other) return idle('another scheduler is running (pid ' + other + ')');
  const routines = (await readJobs(env)).length;
  const controller = new AbortController();
  const done = runDaemon({ env, intervalMs, log, signal: controller.signal }).catch((error) => log('routine scheduler stopped: ' + error.message));
  return { hosted: true, reason: '', routines, stop: async () => { controller.abort(); await done; } };
}

// Long-running scheduler loop. Only one daemon per config folder.
export async function runDaemon({ env = process.env, intervalMs = 30_000, log = () => {}, signal } = {}) {
  const dir = schedulesDirectory(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const pidFile = path.join(dir, 'daemon.pid');
  const other = await runningDaemonPid(env);
  if (other) throw new Error('A routine daemon is already running (pid ' + other + ').');
  await writeFile(pidFile, String(process.pid) + '\n', { mode: 0o600 });
  log('Routine daemon started (pid ' + process.pid + '); checking every ' + Math.round(intervalMs / 1000) + 's.');
  try {
    while (!signal?.aborted) {
      try {
        const result = await tick({ env });
        for (const id of result.fired) log('started ' + id);
        for (const id of result.finished) log('finished ' + id);
        for (const item of result.blocked) log('blocked ' + item.id + ': ' + item.reason);
      } catch (error) { log('tick failed: ' + error.message); }
      await new Promise((resolve) => { const timer = setTimeout(resolve, intervalMs); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
    }
  } finally {
    try { if (Number((await readFile(pidFile, 'utf8')).trim()) === process.pid) await rm(pidFile, { force: true }); } catch {}
  }
}

export function describeJob(job) {
  const state = job.activeRun ? 'running' : job.enabled === false ? job.state || 'paused' : 'scheduled';
  const next = job.activeRun ? 'running since ' + job.activeRun.startedAt : job.enabled !== false && job.nextRunAt ? 'next ' + job.nextRunAt : '';
  return [job.id, state.padEnd(9), job.schedule.display + (job.timezone ? ' (' + job.timezone + ')' : ''), job.kind === 'script' ? '[script]' : '', job.name ? '"' + job.name + '"' : '', next, job.lastStatus ? 'last: ' + job.lastStatus : '', job.deliver && job.deliver !== 'local' ? '→ ' + job.deliver : ''].filter(Boolean).join('  ');
}
