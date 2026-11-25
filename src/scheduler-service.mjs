// `oasis schedule install|uninstall|service`: run the routine scheduler as an OS
// service (systemd user unit, launchd LaunchAgent or a Windows logon task), so
// routines keep firing after a reboot or logout without a terminal open.
import { execFile } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { schedulesDirectory } from './routines.mjs';

export const SERVICE_NAME = 'oasis-scheduler';
const LAUNCHD_LABEL = 'ai.oasis.scheduler';
const WINDOWS_TASK = 'OASIS Scheduler';
const OASIS_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'oasis.mjs');

// Settings the daemon needs from the installing shell. A service starts with an
// almost empty environment, so without these it would read a different config
// or not find git, gh and the user's tools.
const CARRIED_ENV = ['PATH', 'OASIS_CONFIG_DIR', 'OASIS_HOME', 'XDG_CONFIG_HOME', 'OASIS_ROUTINE_MAX_FAILURES', 'OASIS_ROUTINE_TIMEOUT_MINUTES', 'OASIS_SCHEDULE_MAX_PARALLEL'];

const systemdQuote = (value) => '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%') + '"';
const xml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function serviceSpec({ platform = process.platform, env = process.env, home = env.HOME || os.homedir(), nodePath = process.execPath, entry = OASIS_ENTRY, interval } = {}) {
  const args = [nodePath, entry, 'schedule', 'daemon', ...(interval ? ['--interval', String(interval)] : [])];
  const carried = CARRIED_ENV.filter((name) => env[name]).map((name) => [name, env[name]]);
  const logFile = path.join(schedulesDirectory(env), 'daemon.log');
  if (platform === 'linux') {
    const file = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', SERVICE_NAME + '.service');
    const content = [
      '# Installed by: oasis schedule install (remove with: oasis schedule uninstall)',
      '[Unit]',
      'Description=OASIS routine scheduler',
      'After=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      'ExecStart=' + args.map(systemdQuote).join(' '),
      ...carried.map(([name, value]) => 'Environment=' + systemdQuote(name + '=' + value)),
      'Restart=on-failure',
      'RestartSec=10',
      '',
      '[Install]',
      'WantedBy=default.target',
      ''
    ].join('\n');
    const unit = SERVICE_NAME + '.service';
    return {
      kind: 'systemd', file, content, logs: 'journalctl --user -u ' + SERVICE_NAME + ' -f',
      install: [['systemctl', ['--user', 'daemon-reload']], ['systemctl', ['--user', 'enable', '--now', unit]]],
      uninstall: [['systemctl', ['--user', 'disable', '--now', unit]]],
      after: [['systemctl', ['--user', 'daemon-reload']]],
      status: ['systemctl', ['--user', 'is-active', unit]],
      note: 'To keep routines running while you are logged out: loginctl enable-linger ' + (env.USER || '$USER')
    };
  }
  if (platform === 'darwin') {
    const file = path.join(home, 'Library', 'LaunchAgents', LAUNCHD_LABEL + '.plist');
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    const content = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<!-- Installed by: oasis schedule install (remove with: oasis schedule uninstall) -->',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key><string>' + LAUNCHD_LABEL + '</string>',
      '  <key>ProgramArguments</key>',
      '  <array>',
      ...args.map((arg) => '    <string>' + xml(arg) + '</string>'),
      '  </array>',
      ...(carried.length ? ['  <key>EnvironmentVariables</key>', '  <dict>', ...carried.map(([name, value]) => '    <key>' + xml(name) + '</key><string>' + xml(value) + '</string>'), '  </dict>'] : []),
      '  <key>RunAtLoad</key><true/>',
      '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
      '  <key>StandardOutPath</key><string>' + xml(logFile) + '</string>',
      '  <key>StandardErrorPath</key><string>' + xml(logFile) + '</string>',
      '</dict>',
      '</plist>',
      ''
    ].join('\n');
    const domain = 'gui/' + uid;
    return {
      kind: 'launchd', file, content, logs: 'tail -f ' + logFile,
      // bootout first so a reinstall picks up the new plist; its failure is fine.
      install: [['launchctl', ['bootout', domain + '/' + LAUNCHD_LABEL], { optional: true }], ['launchctl', ['bootstrap', domain, file]]],
      uninstall: [['launchctl', ['bootout', domain + '/' + LAUNCHD_LABEL], { optional: true }]],
      after: [],
      status: ['launchctl', ['print', domain + '/' + LAUNCHD_LABEL]]
    };
  }
  if (platform === 'win32') {
    const winQuote = (value) => '"' + String(value) + '"';
    const command = args.map(winQuote).join(' ');
    return {
      kind: 'schtasks', file: null, content: 'schtasks /Create /TN "' + WINDOWS_TASK + '" /SC ONLOGON /RL LIMITED /F /TR ' + command, logs: 'oasis schedule list',
      install: [['schtasks', ['/Create', '/TN', WINDOWS_TASK, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F', '/TR', command]], ['schtasks', ['/Run', '/TN', WINDOWS_TASK], { optional: true }]],
      uninstall: [['schtasks', ['/End', '/TN', WINDOWS_TASK], { optional: true }], ['schtasks', ['/Delete', '/TN', WINDOWS_TASK, '/F']]],
      after: [],
      status: ['schtasks', ['/Query', '/TN', WINDOWS_TASK]],
      note: carried.some(([name]) => name !== 'PATH') ? 'The task runs with your user environment; set ' + carried.filter(([name]) => name !== 'PATH').map(([name]) => name).join(', ') + ' as user environment variables so the daemon sees them.' : ''
    };
  }
  throw new Error('oasis schedule install supports Linux (systemd), macOS (launchd) and Windows (Task Scheduler); on ' + platform + ', run "oasis schedule daemon" from your init system.');
}

function run(command, args, runner) {
  return new Promise((resolve) => {
    runner(command, args, { timeout: 30_000, windowsHide: true }, (error, stdout, stderr) => resolve({ ok: !error, code: error?.code, stdout: String(stdout || ''), stderr: String(stderr || '') || error?.message || '' }));
  });
}

export async function installService({ env = process.env, platform = process.platform, runner = execFile, interval, dryRun = false, ...rest } = {}) {
  const spec = serviceSpec({ platform, env, interval, ...rest });
  if (dryRun) return { spec, steps: [] };
  if (spec.file) {
    await mkdir(path.dirname(spec.file), { recursive: true });
    await writeFile(spec.file, spec.content, { mode: 0o644 });
  }
  await mkdir(schedulesDirectory(env), { recursive: true, mode: 0o700 });
  const steps = [];
  for (const [command, args, options = {}] of spec.install) {
    const result = await run(command, args, runner);
    steps.push({ command: [command, ...args].join(' '), ...result });
    if (!result.ok && !options.optional) {
      const hint = spec.kind === 'systemd' && /bus|connect/i.test(result.stderr) ? ' (no systemd user session here; run "oasis schedule daemon" under your own supervisor instead)' : '';
      if (spec.file) await rm(spec.file, { force: true }).catch(() => {});
      throw new Error([command, ...args].join(' ') + ' failed: ' + result.stderr.trim() + hint);
    }
  }
  return { spec, steps };
}

export async function uninstallService({ env = process.env, platform = process.platform, runner = execFile, ...rest } = {}) {
  const spec = serviceSpec({ platform, env, ...rest });
  const steps = [];
  for (const [command, args] of spec.uninstall) steps.push({ command: [command, ...args].join(' '), ...(await run(command, args, runner)) });
  let removed = false;
  if (spec.file) { try { await stat(spec.file); await rm(spec.file, { force: true }); removed = true; } catch {} }
  for (const [command, args] of spec.after) await run(command, args, runner);
  const failed = steps.filter((step) => !step.ok);
  return { spec, steps, removed: removed || (spec.kind === 'schtasks' && !failed.length) };
}

export async function serviceStatus({ env = process.env, platform = process.platform, runner = execFile, ...rest } = {}) {
  const spec = serviceSpec({ platform, env, ...rest });
  let installed = !spec.file;
  if (spec.file) { try { await stat(spec.file); installed = true; } catch {} }
  const [command, args] = spec.status;
  const result = await run(command, args, runner);
  const running = spec.kind === 'systemd' ? result.stdout.trim() === 'active' : spec.kind === 'launchd' ? result.ok && /state = running/.test(result.stdout) : result.ok && /Running/i.test(result.stdout);
  if (spec.kind === 'schtasks') installed = result.ok;
  return { spec, installed, running, detail: (result.stdout || result.stderr).trim().split('\n').slice(0, 3).join('\n') };
}
