// `oasis schedule` (aliases: cron, routines): durable scheduled jobs. See src/routines.mjs.
import path from 'node:path';
import { stdout } from 'node:process';
import { cancelRun, createJob, describeJob, formatWhen, editJob, listRuns, pauseJob, readJobs, removeFinished, removeJob, resumeJob, runDaemon, tick, triggerJob } from './routines.mjs';

const SCHEDULE_USAGE = `Usage: oasis schedule COMMAND

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
  oasis schedule prune                           delete routines that finished (one-time runs)
  oasis schedule tick                            one scheduler pass, then exit
  oasis schedule daemon [--interval SECONDS]     keep running and fire routines
  oasis schedule install [--interval S] [--print] run the scheduler as an OS service
                                                 (systemd, launchd or Task Scheduler) that
                                                 survives reboots
  oasis schedule uninstall                       remove that service
  oasis schedule service                         is the service installed and running?

SCHEDULE: "weekdays at 9am", "daily at 18:30", "every monday at 14:00", "0 9 * * 1-5" (cron), "every 2h", "in 30m", 2026-12-01T09:00, or
          "webhook" (runs when oasis web receives a signed POST; see show), or an RFC 5545 rule such as
          "DTSTART;TZID=Asia/Dhaka:20261201T090000 RRULE:FREQ=MONTHLY;BYDAY=-1FR" (last Friday each month;
          DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH, BYHOUR, BYMINUTE)
Options:
  --name NAME              a name you can use instead of the id
  --workdir DIR            run in this project folder (default: home folder)
  --script                 PROMPT is a shell command; no model is used
  --model MODEL            model for this routine
  --permission-mode MODE   manual (default), accept-edits, plan, auto
                           or dont-ask
  --skill NAME             load a skill first (repeatable)
  --deliver TARGET         local (default), home (the chat where you sent
                           /sethome), telegram:CHAT_ID, slack:CHANNEL,
                           discord:CHANNEL_ID, matrix:, signal:, email:,
                           whatsapp:, mattermost: or webhook:https://...
  --tz ZONE                time zone for cron schedules, e.g. Asia/Dhaka
  --grace MINUTES          how late a missed cron slot may still run (0 = never)
  --precheck CMD           agent routines: run CMD first and start the model only
                           if it prints something (its output joins the prompt;
                           nothing or [SILENT] = skipped, no model call)
  SCHEDULE "after NAME"    run when routine NAME finishes ok ("after NAME failed",
                           "after NAME any"); {output} and {status} hold its result
  --timeout MINUTES        stop a run that takes longer (default: no limit,
                           or OASIS_ROUTINE_TIMEOUT_MINUTES)
  --event NAME             webhook routines: run only for this event, e.g.
                           pull_request, pull_request.opened, issues.labeled
                           (repeatable; from X-GitHub-Event or X-OASIS-Event
                           and the payload's "action"); --any-event clears it
  --from-session ID        each run starts from this saved conversation (forked,
                           so the original is never changed); '' clears it
  --chain                  with --from-session: each run continues from the
                           previous run's conversation (--no-chain to stop)
  --paused                 create it paused (resume when ready)
Output starting with [SILENT] is saved but not delivered. Each routine keeps its newest
200 runs and 30 days of output (OASIS_ROUTINE_HISTORY, OASIS_ROUTINE_HISTORY_DAYS).`;

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
    else if (arg === '--from-session') fields.fromSession = value();
    else if (arg === '--chain') fields.chain = true;
    else if (arg === '--no-chain') fields.chain = false;
    else if (arg === '--any-event') fields.events = [];
    else if (arg === '--deliver') fields.deliver = value();
    else if (arg === '--tz' || arg === '--timezone') fields.timezone = value();
    else if (arg === '--grace' || arg === '--grace-minutes') { const v = value(); fields.graceMinutes = v === '' ? null : Number(v); }
    else if (arg === '--precheck' || arg === '--check') { fields.precheck = value() || null; }
    else if (arg === '--timeout' || arg === '--timeout-minutes') { const v = value(); fields.timeoutMinutes = v === '' ? null : Number(v); }
    else if (arg === '--paused') fields.paused = true;
    else if (arg === '--reason') fields.reason = value();
    else if (arg === '--schedule') fields.schedule = value();
    else if (arg === '--prompt') fields.prompt = value();
    else if (arg === '--interval') fields.interval = Number(value());
    else if (arg === '--json') fields.json = true;
    else if (arg === '--print' || arg === '--dry-run') fields.dryRun = true;
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
    if (job.schedule.source === 'routine') say('It runs each time ' + job.schedule.display.replace(/^after /, '') + ' finishes' + (job.schedule.on === 'failed' ? ' with a failure.' : job.schedule.on === 'any' ? ' (ok or failed).' : ' successfully.') + ' Use {output} and {status} in the prompt for its result.');
    else if (job.schedule.type === 'event') say('Webhook: POST /hooks/routines/' + job.id + ' on oasis web, signed with the secret from: oasis schedule show ' + job.id);
    say(job.enabled ? 'It runs while the scheduler is running: oasis schedule install (once; starts with the computer) or oasis schedule daemon' : 'It is paused. Resume it with: oasis schedule resume ' + job.id);
    return job;
  }
  if (sub === 'list' || sub === 'ls') {
    const jobs = await readJobs(env);
    if (fields.json) return say(JSON.stringify(jobs, null, 2));
    if (!jobs.length) return say('No routines. Create one with: oasis schedule add "every 1d" "summarize new issues" --workdir .');
    for (const job of jobs) say(describeJob(job));
    return jobs;
  }
  if (sub === 'prune') { const ids = await removeFinished({ env }); say(ids.length ? 'Removed ' + ids.length + ' finished routine' + (ids.length === 1 ? '' : 's') + ': ' + ids.join(', ') : 'No finished routines.'); return ids; }
  const ref = positional[0];
  if (sub === 'show' || sub === 'runs') {
    const { job, runs } = await listRuns(ref, { env });
    if (fields.json) return say(JSON.stringify({ job, runs }, null, 2));
    say(describeJob(job));
    say('  ' + (job.kind === 'script' ? 'command: ' : 'prompt: ') + job.prompt.split('\n')[0].slice(0, 200));
    if (job.workdir) say('  workdir: ' + job.workdir);
    if (job.precheck) say('  precheck: ' + job.precheck);
    if (job.timeoutMinutes) say('  timeout: ' + job.timeoutMinutes + ' min per run');
    if (job.fromSession) say('  continues: ' + job.fromSession + (job.chain ? ' (chained: each run continues the last one)' : ' (each run forks it)'));
    if (job.schedule.source === 'routine') { if (job.pendingEvents?.length) say('  waiting: ' + job.pendingEvents.length + ' finished run(s) to act on'); }
    else if (job.schedule.type === 'event') {
      if (job.events?.length) say('  events:  ' + job.events.join(', '));
      say('  webhook: POST <oasis web address>/hooks/routines/' + job.id + (job.pendingEvents?.length ? '  (' + job.pendingEvents.length + ' waiting)' : ''));
      say('  secret:  ' + job.webhookSecret + '  (sign the raw body: X-Hub-Signature-256: sha256=HMAC_SHA256_HEX)');
    }
    if (job.skills?.length) say('  skills: ' + job.skills.join(', '));
    if (job.pausedReason && job.enabled === false) say('  paused: ' + job.pausedReason);
    if (job.lastProblem) say('  blocked: ' + job.lastProblem);
    if (!runs.length) say('  No runs yet.');
    for (const run of runs) say('  ' + [formatWhen(run.finishedAt || run.startedAt, { timezone: job.timezone }), run.status, run.manual ? 'manual' : '', run.backgroundId || '', run.reason || '', run.deliveryError ? 'delivery failed: ' + run.deliveryError : '', run.outputFile || ''].filter(Boolean).join('  '));
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
  if (sub === 'install') {
    const { installService } = await import('./scheduler-service.mjs');
    const { spec } = await installService({ env, interval: fields.interval, dryRun: fields.dryRun });
    if (fields.dryRun) { say((spec.file ? '# ' + spec.file + '\n' : '') + spec.content); return spec; }
    say('Installed the routine scheduler as a ' + ({ systemd: 'systemd user service', launchd: 'launchd agent', schtasks: 'Windows logon task' })[spec.kind] + (spec.file ? ' (' + spec.file + ')' : '') + '. It starts now and at every login, and restarts if it crashes.');
    say('Logs: ' + spec.logs + '   Status: oasis schedule service   Remove: oasis schedule uninstall');
    if (spec.note) say(spec.note);
    return spec;
  }
  if (sub === 'uninstall') {
    const { uninstallService } = await import('./scheduler-service.mjs');
    const { removed } = await uninstallService({ env });
    say(removed ? 'Removed the routine scheduler service. Routines stay; run them with oasis schedule daemon.' : 'No routine scheduler service was installed.');
    return removed;
  }
  if (sub === 'service' || sub === 'status') {
    const { serviceStatus } = await import('./scheduler-service.mjs');
    const status = await serviceStatus({ env });
    say(!status.installed ? 'The scheduler service is not installed. Install it with: oasis schedule install' : 'The scheduler service is installed and ' + (status.running ? 'running.' : 'not running.') + (status.spec.file ? '\n  ' + status.spec.file : '') + (status.detail && !status.running ? '\n  ' + status.detail.replace(/\n/g, '\n  ') : '') + '\nLogs: ' + status.spec.logs);
    return status;
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
