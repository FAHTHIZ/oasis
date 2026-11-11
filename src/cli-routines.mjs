// `oasis schedule` (aliases: cron, routines): durable scheduled jobs. See src/routines.mjs.
import path from 'node:path';
import { stdout } from 'node:process';
import { cancelRun, createJob, describeJob, editJob, listRuns, pauseJob, readJobs, removeJob, resumeJob, runDaemon, tick, triggerJob } from './routines.mjs';

export const SCHEDULE_USAGE = `Usage: oasis schedule COMMAND

Routines run on a schedule in fresh background sessions, even with no terminal open.
Start the scheduler with "oasis schedule daemon" (or run "oasis schedule tick" from cron).

  oasis schedule add SCHEDULE PROMPT [options]   create a routine
  oasis schedule list [--json]                   list routines
  oasis schedule show ID|NAME                    details and recent runs
  oasis schedule edit ID|NAME [options]          change a routine
  oasis schedule pause ID|NAME [--reason TEXT]   stop scheduling it
  oasis schedule resume ID|NAME                  schedule it again
  oasis schedule run ID|NAME                     run it on the next tick (extra run)
  oasis schedule cancel ID|NAME                  stop the run in progress
  oasis schedule remove ID|NAME                  delete it (stops a live run)
  oasis schedule tick                            one scheduler pass, then exit
  oasis schedule daemon [--interval SECONDS]     keep running and fire routines

SCHEDULE: "0 9 * * 1-5" (cron), "every 2h", "in 30m", 2026-12-01T09:00, or
          "webhook" (runs when oasis web receives a signed POST; see show)
Options:
  --name NAME              a name you can use instead of the id
  --workdir DIR            run in this project folder (default: home folder)
  --script                 PROMPT is a shell command; no model is used
  --model MODEL            model for this routine
  --permission-mode MODE   default, acceptEdits, plan, auto or dontAsk
  --skill NAME             load a skill first (repeatable)
  --deliver TARGET         local (default), telegram:CHAT_ID, slack:CHANNEL,
                           discord:CHANNEL_ID or webhook:https://...
  --tz ZONE                time zone for cron schedules, e.g. Asia/Dhaka
  --grace MINUTES          how late a missed cron slot may still run (0 = never)
  --event NAME             webhook routines: run only for this event, e.g.
                           pull_request, pull_request.opened, issues.labeled
                           (repeatable; from X-GitHub-Event or X-OASIS-Event
                           and the payload's "action"); --any-event clears it
  --paused                 create it paused (resume when ready)
Output starting with [SILENT] is saved but not delivered.`;

function parseOptions(args) {
  const fields = {};
  const positional = [];
  const skills = [];
  const events = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = () => { if (i + 1 >= args.length) throw new Error(arg + ' needs a value.'); return args[++i]; };
    if (arg === '--name') fields.name = value();
    else if (arg === '--workdir') { const dir = value(); fields.workdir = dir ? path.resolve(dir) : ''; }
    else if (arg === '--script') fields.kind = 'script';
    else if (arg === '--agent') fields.kind = 'agent';
    else if (arg === '--model') fields.model = value();
    else if (arg === '--permission-mode') fields.permissionMode = value();
    else if (arg === '--skill') skills.push(value());
    else if (arg === '--clear-skills') fields.skills = [];
    else if (arg === '--event') events.push(value());
    else if (arg === '--any-event') fields.events = [];
    else if (arg === '--deliver') fields.deliver = value();
    else if (arg === '--tz' || arg === '--timezone') fields.timezone = value();
    else if (arg === '--grace' || arg === '--grace-minutes') { const v = value(); fields.graceMinutes = v === '' ? null : Number(v); }
    else if (arg === '--paused') fields.paused = true;
    else if (arg === '--reason') fields.reason = value();
    else if (arg === '--schedule') fields.schedule = value();
    else if (arg === '--prompt') fields.prompt = value();
    else if (arg === '--interval') fields.interval = Number(value());
    else if (arg === '--json') fields.json = true;
    else positional.push(arg);
  }
  if (skills.length) fields.skills = skills;
  if (events.length) fields.events = events;
  return { fields, positional };
}

export async function scheduleCommand(args = [], { env = process.env, write = (text) => stdout.write(text) } = {}) {
  const [sub = 'list', ...rest] = args;
  const { fields, positional } = parseOptions(rest);
  const say = (text) => write(text + '\n');
  if (sub === 'help' || sub === '--help' || sub === '-h') return say(SCHEDULE_USAGE);
  if (sub === 'add' || sub === 'create') {
    const [schedule, ...promptParts] = positional;
    const prompt = fields.prompt || promptParts.join(' ');
    if (!schedule || !prompt) return say(SCHEDULE_USAGE);
    const job = await createJob({ ...fields, schedule, prompt }, { env });
    say('Created ' + describeJob(job));
    if (job.schedule.type === 'event') say('Webhook: POST /hooks/routines/' + job.id + ' on oasis web, signed with the secret from: oasis schedule show ' + job.id);
    say(job.enabled ? 'It runs while the scheduler is running: oasis schedule daemon' : 'It is paused. Resume it with: oasis schedule resume ' + job.id);
    return job;
  }
  if (sub === 'list' || sub === 'ls') {
    const jobs = await readJobs(env);
    if (fields.json) return say(JSON.stringify(jobs, null, 2));
    if (!jobs.length) return say('No routines. Create one with: oasis schedule add "every 1d" "summarize new issues" --workdir .');
    for (const job of jobs) say(describeJob(job));
    return jobs;
  }
  const ref = positional[0];
  if (sub === 'show' || sub === 'runs') {
    const { job, runs } = await listRuns(ref, { env });
    if (fields.json) return say(JSON.stringify({ job, runs }, null, 2));
    say(describeJob(job));
    say('  ' + (job.kind === 'script' ? 'command: ' : 'prompt: ') + job.prompt.split('\n')[0].slice(0, 200));
    if (job.workdir) say('  workdir: ' + job.workdir);
    if (job.schedule.type === 'event') {
      if (job.events?.length) say('  events:  ' + job.events.join(', '));
      say('  webhook: POST <oasis web address>/hooks/routines/' + job.id + (job.pendingEvents?.length ? '  (' + job.pendingEvents.length + ' waiting)' : ''));
      say('  secret:  ' + job.webhookSecret + '  (sign the raw body: X-Hub-Signature-256: sha256=HMAC_SHA256_HEX)');
    }
    if (job.skills?.length) say('  skills: ' + job.skills.join(', '));
    if (job.pausedReason && job.enabled === false) say('  paused: ' + job.pausedReason);
    if (job.lastProblem) say('  blocked: ' + job.lastProblem);
    if (!runs.length) say('  No runs yet.');
    for (const run of runs) say('  ' + [run.finishedAt || run.startedAt, run.status, run.manual ? 'manual' : '', run.backgroundId || '', run.reason || '', run.deliveryError ? 'delivery failed: ' + run.deliveryError : '', run.outputFile || ''].filter(Boolean).join('  '));
    return { job, runs };
  }
  if (sub === 'edit') { const job = await editJob(ref, fields, { env }); say('Updated ' + describeJob(job)); return job; }
  if (sub === 'pause') { const job = await pauseJob(ref, fields.reason, { env }); say('Paused ' + job.id + '.'); return job; }
  if (sub === 'resume') { const job = await resumeJob(ref, { env }); say('Resumed ' + describeJob(job)); return job; }
  if (sub === 'run' || sub === 'trigger') { const job = await triggerJob(ref, { env }); say(job.id + ' will run on the next scheduler tick (an extra run; its schedule is unchanged).'); return job; }
  if (sub === 'cancel') {
    const { job, cancelled } = await cancelRun(ref, { env });
    say(cancelled ? 'Stopping the current run of ' + job.id + '; its schedule is unchanged.' : job.id + ' has no run in progress.');
    return { job, cancelled };
  }
  if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
    const { stopBackgroundSession } = await import('./background-sessions.mjs');
    const job = await removeJob(ref, { env, stop: stopBackgroundSession });
    say('Removed ' + job.id + (job.activeRun ? ' and stopped its run.' : '.'));
    return job;
  }
  if (sub === 'tick') {
    const result = await tick({ env });
    say('Started ' + result.fired.length + ', finished ' + result.finished.length + ', skipped ' + result.skipped.length + ', blocked ' + result.blocked.length + '.');
    for (const item of [...result.skipped, ...result.blocked]) say('  ' + item.id + ': ' + item.reason);
    return result;
  }
  if (sub === 'daemon') {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    await runDaemon({ env, intervalMs: Math.max(5, fields.interval || 30) * 1000, log: (line) => say(new Date().toISOString() + '  ' + line), signal: controller.signal });
    return;
  }
  return say(SCHEDULE_USAGE);
}
