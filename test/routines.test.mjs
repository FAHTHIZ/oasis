import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { catchUpWindowMs, createJob, editJob, extractRunOutput, findJob, listRuns, nextOccurrence, parseDeliver, parseSchedule, pauseJob, readJobs, removeJob, resumeJob, tick, triggerJob } from '../src/routines.mjs';
import { readEntry } from '../src/background-sessions.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

async function tempEnv(extra = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-rt-'));
  return { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_SCHEDULED_RUN: '', OASIS_BASE_URL: '', OASIS_MODEL: '', OASIS_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ...extra };
}

// A fake background-sessions module: records launches, lets the test decide when they end.
function fakeBackgrounds() {
  const entries = new Map();
  let n = 0;
  const start = (kind) => async (options) => {
    const id = 'bg-fake' + String(++n).padStart(4, '0');
    entries.set(id, { id, status: 'running', kind, options, logFile: null });
    return entries.get(id);
  };
  return {
    entries,
    startBackgroundSession: start('agent'),
    startExecJob: start('exec'),
    readEntry: async (id) => { if (!entries.has(id)) throw new Error('gone'); return entries.get(id); },
    stopBackgroundSession: async (id) => { entries.get(id).status = 'stopped'; }
  };
}

test('schedules: cron, intervals, one-shots and readable errors', () => {
  const now = new Date('2026-11-11T10:00:00Z');
  assert.deepEqual(parseSchedule('every 2h', { now }), { type: 'interval', everyMs: 7_200_000, display: 'every 2h' });
  assert.equal(parseSchedule('in 30m', { now }).at, '2026-11-11T10:30:00.000Z');
  assert.equal(parseSchedule('2026-12-01T09:00:00Z', { now }).at, '2026-12-01T09:00:00.000Z');
  assert.equal(parseSchedule('0 9 * * 1-5', { now }).type, 'cron');
  assert.throws(() => parseSchedule('every 10s', { now }), /shortest interval/);
  assert.throws(() => parseSchedule('whenever', { now }), /Could not read the schedule/);
  assert.throws(() => parseSchedule('', { now }), /needs a schedule/);
  // Per-job time zone: 09:00 in Dhaka (UTC+6) is 03:00 UTC.
  const job = { schedule: { type: 'cron', expr: '0 9 * * *', display: '0 9 * * *' }, timezone: 'Asia/Dhaka' };
  assert.equal(nextOccurrence(job, now), '2026-11-12T03:00:00.000Z');
});

test('catch-up window is half the period, clamped to 2 minutes .. 2 hours, or graceMinutes', () => {
  const at = '2026-11-11T10:00:00.000Z';
  const cron = (expr, extra = {}) => ({ schedule: { type: 'cron', expr, display: expr }, nextRunAt: at, ...extra });
  assert.equal(catchUpWindowMs(cron('* * * * *')), 2 * 60_000);
  assert.equal(catchUpWindowMs(cron('0 * * * *')), 30 * 60_000);
  assert.equal(catchUpWindowMs(cron('0 9 * * *')), 2 * 3_600_000);
  assert.equal(catchUpWindowMs(cron('0 9 * * *', { graceMinutes: 0 })), 0);
  assert.equal(catchUpWindowMs({ schedule: { type: 'interval', everyMs: 60_000 } }), Infinity);
});

test('delivery targets are validated', () => {
  assert.equal(parseDeliver(''), 'local');
  assert.equal(parseDeliver('telegram:123'), 'telegram:123');
  assert.equal(parseDeliver('webhook:http://localhost:9/x'), 'webhook:http://localhost:9/x');
  assert.throws(() => parseDeliver('webhook:http://example.com/x'), /https/);
  assert.throws(() => parseDeliver('email:me'), /Unknown delivery target/);
});

test('lifecycle: create, find by name, edit, pause, resume, remove; ambiguity is refused', async () => {
  const env = await tempEnv();
  const now = new Date('2026-11-11T10:00:00Z');
  const a = await createJob({ schedule: 'every 1h', prompt: 'check CI', name: 'ci' }, { env, now });
  assert.match(a.id, /^rt-[a-z0-9]{8}$/);
  assert.equal(a.nextRunAt, '2026-11-11T11:00:00.000Z');
  assert.equal(findJob(await readJobs(env), 'CI').id, a.id);
  await createJob({ schedule: 'every 1h', prompt: 'other', name: 'dup' }, { env, now });
  await createJob({ schedule: 'every 1h', prompt: 'other', name: 'dup' }, { env, now });
  assert.throws(() => findJob([{ id: 'rt-1', name: 'dup' }, { id: 'rt-2', name: 'dup' }], 'dup'), /matches several/);
  const edited = await editJob('ci', { schedule: '0 9 * * *', timezone: 'Asia/Dhaka', skills: ['debugging'] }, { env, now });
  assert.equal(edited.nextRunAt, '2026-11-12T03:00:00.000Z');
  assert.deepEqual(edited.skills, ['debugging']);
  await assert.rejects(editJob('ci', { workdir: 'relative/dir' }, { env, now }), /absolute/);
  await assert.rejects(editJob('ci', { timezone: 'Mars/Olympus' }, { env, now }), /Unknown time zone/);
  assert.equal((await pauseJob('ci', 'holiday', { env, now })).pausedReason, 'holiday');
  assert.equal((await resumeJob('ci', { env, now })).enabled, true);
  await removeJob('ci', { env });
  assert.equal((await readJobs(env)).length, 2);
  const paused = await createJob({ schedule: 'every 1h', prompt: 'canary', paused: true }, { env, now });
  assert.equal(paused.nextRunAt, null);
  assert.equal(paused.enabled, false);
});

test('a scheduled run cannot create or change routines', async () => {
  const env = await tempEnv({ OASIS_SCHEDULED_RUN: '1' });
  await assert.rejects(createJob({ schedule: 'every 1h', prompt: 'x' }, { env }), /scheduled run cannot/);
});

test('tick fires due jobs once, skips overlap, honours the catch-up window and reconciles results', async () => {
  const env = await tempEnv();
  const bg = fakeBackgrounds();
  const t0 = new Date('2026-11-11T10:00:00Z');
  const job = await createJob({ schedule: 'every 1h', prompt: 'echo hi', kind: 'script', name: 's' }, { env, now: t0 });
  // Not due yet.
  assert.deepEqual((await tick({ env, now: t0, backgrounds: bg })).fired, []);
  const t1 = new Date('2026-11-11T11:00:05Z');
  assert.deepEqual((await tick({ env, now: t1, backgrounds: bg })).fired, [job.id]);
  assert.equal(bg.entries.size, 1);
  assert.equal([...bg.entries.values()][0].options.env.OASIS_SCHEDULED_RUN, '1');
  // Next slot comes due while the first run is still going: skipped, not stacked.
  const t2 = new Date('2026-11-11T12:00:10Z');
  const overlap = await tick({ env, now: t2, backgrounds: bg });
  assert.equal(overlap.skipped[0].reason, 'previous run still active');
  assert.equal(bg.entries.size, 1);
  // The run ends; the next tick records it exactly once.
  [...bg.entries.values()][0].status = 'completed';
  const done = await tick({ env, now: new Date('2026-11-11T12:01:00Z'), backgrounds: bg });
  assert.deepEqual(done.finished, [job.id]);
  const again = await tick({ env, now: new Date('2026-11-11T12:01:30Z'), backgrounds: bg });
  assert.deepEqual(again.finished, []);
  const { runs } = await listRuns(job.id, { env });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'ok');

  // A daily cron slot missed by more than its 2-hour window is skipped, not run late.
  const daily = await createJob({ schedule: '0 9 * * *', prompt: 'x', kind: 'script', timezone: 'UTC' }, { env, now: new Date('2026-11-11T08:00:00Z') });
  const late = await tick({ env, now: new Date('2026-11-11T11:30:00Z'), backgrounds: bg });
  assert.ok(late.skipped.some((s) => s.id === daily.id && /catch-up window/.test(s.reason)));
  assert.equal((await readJobs(env)).find((j) => j.id === daily.id).nextRunAt, '2026-11-12T09:00:00.000Z');
  // Inside the window it still runs late.
  const ontime = await createJob({ schedule: '30 11 * * *', prompt: 'y', kind: 'script', timezone: 'UTC' }, { env, now: new Date('2026-11-11T11:00:00Z') });
  assert.ok((await tick({ env, now: new Date('2026-11-11T12:15:00Z'), backgrounds: bg })).fired.includes(ontime.id));
});

test('one-shot jobs complete; manual runs are extra fires; interrupted runs pause the job', async () => {
  const env = await tempEnv();
  const bg = fakeBackgrounds();
  const t0 = new Date('2026-11-11T10:00:00Z');
  const once = await createJob({ schedule: 'in 5m', prompt: 'remind', kind: 'script' }, { env, now: t0 });
  await tick({ env, now: new Date('2026-11-11T10:06:00Z'), backgrounds: bg });
  const stored = (await readJobs(env)).find((j) => j.id === once.id);
  assert.equal(stored.state, 'completed');
  assert.equal(stored.nextRunAt, null);
  await assert.rejects(resumeJob(once.id, { env }), /already ran/);

  const hourly = await createJob({ schedule: 'every 1h', prompt: 'x', kind: 'script' }, { env, now: t0 });
  await triggerJob(hourly.id, { env });
  const manual = await tick({ env, now: new Date('2026-11-11T10:10:00Z'), backgrounds: bg });
  assert.ok(manual.fired.includes(hourly.id));
  const afterManual = (await readJobs(env)).find((j) => j.id === hourly.id);
  assert.equal(afterManual.nextRunAt, '2026-11-11T11:00:00.000Z', 'a manual run does not move the schedule');
  assert.equal(afterManual.activeRun.manual, true);
  // The machine rebooted mid-run: never re-run it automatically.
  bg.entries.get(afterManual.activeRun.backgroundId).status = 'interrupted';
  await tick({ env, now: new Date('2026-11-11T10:20:00Z'), backgrounds: bg });
  const paused = (await readJobs(env)).find((j) => j.id === hourly.id);
  assert.equal(paused.enabled, false);
  assert.match(paused.pausedReason, /interrupted/);
});

test('an agent routine with no usable model is blocked once and makes no model call', async () => {
  const env = await tempEnv({ OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: 'https://api.example.invalid/v1', OASIS_MODEL: 'm' });
  const bg = fakeBackgrounds();
  const t0 = new Date('2026-11-11T10:00:00Z');
  const job = await createJob({ schedule: 'every 1h', prompt: 'x' }, { env, now: t0 });
  const first = await tick({ env, now: new Date('2026-11-11T11:00:01Z'), backgrounds: bg });
  assert.equal(first.blocked[0].id, job.id);
  assert.match(first.blocked[0].reason, /no usable model credentials/);
  assert.equal(bg.entries.size, 0);
  await tick({ env, now: new Date('2026-11-11T12:00:01Z'), backgrounds: bg });
  const { runs } = await listRuns(job.id, { env });
  assert.equal(runs.filter((r) => r.status === 'blocked_config').length, 1, 'recorded once, not every tick');
});

test('run output: stream-json result, script exit codes', () => {
  const log = [JSON.stringify({ type: 'assistant', text: 'working' }), JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'All done' })].join('\n');
  assert.deepEqual(extractRunOutput(log), { output: 'All done', isError: false });
  assert.equal(extractRunOutput('no result').missing, true);
  assert.deepEqual(extractRunOutput('hello\n[exit 0]\n', 'script'), { output: 'hello', isError: false });
  assert.equal(extractRunOutput('boom\n[exit 2]\n', 'script').isError, true);
});

async function fakeTelegram(t) {
  const messages = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    messages.push({ url: req.url, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json'); res.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: 'http://127.0.0.1:' + server.address().port, messages };
}

async function waitForFinish(env, id) {
  for (let i = 0; i < 400; i++) {
    const job = (await readJobs(env)).find((j) => j.id === id);
    if (job.activeRun) {
      const entry = await readEntry(job.activeRun.backgroundId, env);
      if (entry.status !== 'running') return entry;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('run did not finish');
}

test('end to end: a real agent routine runs headless, saves output and delivers it to Telegram', async (t) => {
  const { config, requests } = await scriptedModel(t, [{ content: 'Nightly report: 3 issues triaged.' }]);
  const tg = await fakeTelegram(t);
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-rt-root-'));
  const env = await tempEnv({ OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_TELEGRAM_BOT_TOKEN: 'tok', OASIS_TELEGRAM_API_BASE: tg.base });
  const job = await createJob({ schedule: 'every 1h', prompt: 'Triage new issues.', workdir: root, deliver: 'telegram:42', name: 'nightly', skills: ['debugging'] }, { env, now: new Date(Date.now() - 2 * 3_600_000) });
  const fired = await tick({ env });
  assert.deepEqual(fired.fired, [job.id]);
  const entry = await waitForFinish(env, job.id);
  assert.equal(entry.status, 'completed', await readFile(entry.logFile, 'utf8'));
  const done = await tick({ env });
  assert.deepEqual(done.finished, [job.id]);
  const prompt = JSON.stringify(requests[0].messages);
  assert.match(prompt, /scheduled run of the routine/);
  assert.match(prompt, /debugging/);
  assert.match(prompt, /Triage new issues/);
  const { runs } = await listRuns(job.id, { env });
  assert.equal(runs.at(-1).status, 'ok');
  assert.equal(runs.at(-1).delivery, 'telegram:42');
  assert.match(await readFile(runs.at(-1).outputFile, 'utf8'), /3 issues triaged/);
  assert.equal(tg.messages.length, 1);
  assert.equal(tg.messages[0].url, '/bottok/sendMessage');
  assert.equal(tg.messages[0].body.chat_id, '42');
  assert.match(tg.messages[0].body.text, /nightly .*\n\nNightly report/);
});

test('end to end: a script routine with [SILENT] output is saved but not delivered', async (t) => {
  const tg = await fakeTelegram(t);
  const env = await tempEnv({ OASIS_TELEGRAM_BOT_TOKEN: 'tok', OASIS_TELEGRAM_API_BASE: tg.base });
  const job = await createJob({ schedule: 'every 1h', prompt: 'echo "[SILENT] nothing new"', kind: 'script', deliver: 'telegram:1' }, { env, now: new Date(Date.now() - 2 * 3_600_000) });
  await tick({ env });
  await waitForFinish(env, job.id);
  await tick({ env });
  const { runs } = await listRuns(job.id, { env });
  assert.equal(runs.at(-1).status, 'ok');
  assert.equal(runs.at(-1).silent, true);
  assert.equal(tg.messages.length, 0);
});

test('CLI: oasis schedule keeps its own --name/--model flags and lists routines', async () => {
  const env = await tempEnv();
  const add = spawnSync(process.execPath, [CLI, 'schedule', 'add', 'every 2h', 'summarize issues', '--name', 'digest', '--model', 'cheap', '--permission-mode', 'plan'], { env, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr);
  const [job] = await readJobs(env);
  assert.equal(job.name, 'digest');
  assert.equal(job.model, 'cheap');
  assert.equal(job.permissionMode, 'plan');
  const list = spawnSync(process.execPath, [CLI, 'cron', 'list'], { env, encoding: 'utf8' });
  assert.match(list.stdout, /every 2h\s+"digest"/);
  const bad = spawnSync(process.execPath, [CLI, 'schedule', 'add', 'nonsense', 'x'], { env, encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Could not read the schedule/);
});

test('delivered output has secrets redacted', async (t) => {
  const tg = await fakeTelegram(t);
  const env = await tempEnv({ OASIS_TELEGRAM_BOT_TOKEN: 'tok', OASIS_TELEGRAM_API_BASE: tg.base });
  const { deliverOutput } = await import('../src/routines.mjs');
  await deliverOutput({ id: 'rt-00000000', deliver: 'telegram:9' }, 'key is sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD', { env });
  assert.equal(tg.messages.length, 1);
  assert.doesNotMatch(tg.messages[0].body.text, /abcdefghijklmnopqrstuvwxyz0123456789/);
  assert.match(tg.messages[0].body.text, /redacted/);
});

test('editing a routine can clear optional fields', async () => {
  const env = await tempEnv();
  const job = await createJob({ schedule: '0 9 * * *', prompt: 'x', timezone: 'Asia/Dhaka', model: 'm1', workdir: '/tmp' }, { env });
  const edited = await editJob(job.id, { timezone: '', model: '', workdir: '' }, { env });
  assert.equal(edited.timezone, undefined);
  assert.equal(edited.model, undefined);
  assert.equal(edited.workdir, undefined);
  const [saved] = await readJobs(env);
  assert.equal('timezone' in saved || 'model' in saved || 'workdir' in saved, false);
});
