// Worktree setup files from other agents, run after OASIS creates a git worktree:
//   Cursor        .cursor/worktrees.json  "setup-worktree-unix" | "setup-worktree-windows" |
//                 "setup-worktree": an array of shell commands run in order in the new
//                 worktree, or a script path relative to worktrees.json. Looked up in the
//                 worktree first, then the project root. $ROOT_WORKTREE_PATH = project root.
//                 https://cursor.com/docs/configuration/worktrees
//   Windsurf      .windsurf/hooks.json  hooks.post_setup_worktree[].command, run in the new
//                 worktree with $ROOT_WORKSPACE_PATH = project root.
//                 https://docs.windsurf.com/windsurf/cascade/workflows
// These are repository-supplied commands, so they run only in a trusted workspace
// (oasis trust); otherwise the result says how to allow them. OASIS_WORKTREE_SETUP=0
// turns this off.
import path from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { runWorktreeCommand } from './worktrees.mjs';

const MAX_CONFIG = 64 * 1024;
const MAX_COMMANDS = 40;
const COMMAND_TIMEOUT = 10 * 60 * 1000;

function inside(base, target) {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function readJson(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_CONFIG) return null;
    return JSON.parse(await readFile(file, 'utf8'));
  } catch { return null; }
}

function shellCommand(command, platform) {
  return platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', command]] : ['/bin/sh', ['-c', command]];
}

/** The setup steps a worktree would run, or null. Exported for tests. */
export async function worktreeSetupPlan(root, worktreePath, options = {}) {
  const platform = options.platform || process.platform;
  for (const base of [worktreePath, root]) {
    const file = path.join(base, '.cursor', 'worktrees.json');
    const config = await readJson(file);
    if (!config || typeof config !== 'object') continue;
    const key = [platform === 'win32' ? 'setup-worktree-windows' : 'setup-worktree-unix', 'setup-worktree'].find((name) => config[name] !== undefined);
    if (!key) continue;
    const value = config[key];
    const source = '.cursor/worktrees.json (' + key + ')';
    if (Array.isArray(value)) {
      const commands = value.filter((item) => typeof item === 'string' && item.trim()).slice(0, MAX_COMMANDS);
      return { source, file, env: { ROOT_WORKTREE_PATH: root }, steps: commands.map((command) => ({ label: command, argv: shellCommand(command, platform) })) };
    }
    if (typeof value === 'string' && value.trim()) {
      const script = path.resolve(path.dirname(file), value.trim());
      let real;
      try { real = await realpath(script); } catch { return { source, file, error: 'setup script ' + value + ' does not exist' }; }
      const baseReal = await realpath(base);
      if (!inside(baseReal, real)) return { source, file, error: 'setup script ' + value + ' is outside the repository' };
      const ext = path.extname(real).toLowerCase();
      let argv;
      if (platform === 'win32') argv = ext === '.ps1' ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', real]] : ['cmd.exe', ['/d', '/s', '/c', real]];
      else argv = ['/bin/sh', [real]];
      return { source, file, env: { ROOT_WORKTREE_PATH: root }, steps: [{ label: value.trim(), argv }] };
    }
  }
  const hooksFile = path.join(root, '.windsurf', 'hooks.json');
  const hooks = await readJson(hooksFile);
  const entries = hooks && hooks.hooks && Array.isArray(hooks.hooks.post_setup_worktree) ? hooks.hooks.post_setup_worktree : [];
  const commands = entries.map((entry) => (entry && typeof entry.command === 'string' ? entry.command.trim() : '')).filter(Boolean).slice(0, MAX_COMMANDS);
  if (commands.length) return { source: '.windsurf/hooks.json (post_setup_worktree)', file: hooksFile, env: { ROOT_WORKSPACE_PATH: root }, steps: commands.map((command) => ({ label: command, argv: shellCommand(command, platform) })) };
  return null;
}

/**
 * Runs the Cursor or Windsurf worktree setup for a new worktree. Never throws:
 * returns { source, ran, ok, failed, output } or { skipped } or null when there is none.
 */
export async function runWorktreeSetup(root, worktreePath, options = {}) {
  const env = options.env || process.env;
  if (env.OASIS_WORKTREE_SETUP === '0') return null;
  let plan;
  try { plan = await worktreeSetupPlan(root, worktreePath, options); } catch { return null; }
  if (!plan) return null;
  if (plan.error) return { source: plan.source, ok: false, ran: 0, output: plan.error };
  let trusted = false;
  try {
    const { isWorkspaceTrusted } = await import('./settings.mjs');
    trusted = await isWorkspaceTrusted(root, env);
  } catch {}
  if (!trusted) return { source: plan.source, skipped: true, output: 'Worktree setup from ' + plan.source + ' was not run because this workspace is not trusted. Run `oasis trust` to allow it.' };
  const childEnv = { ...env, ...plan.env };
  let output = '';
  let ran = 0;
  for (const step of plan.steps) {
    const [command, args] = step.argv;
    const result = await runWorktreeCommand(command, args, { cwd: worktreePath, env: childEnv, timeout: options.timeout || COMMAND_TIMEOUT, signal: options.signal });
    ran += 1;
    output += [result.stdout, result.stderr].filter(Boolean).join('\n') + '\n';
    if (result.exitCode !== 0) {
      return { source: plan.source, ok: false, ran, failed: step.label, exitCode: result.exitCode, output: output.trim().slice(-2000) };
    }
  }
  return { source: plan.source, ok: true, ran, output: output.trim().slice(-2000) };
}

/** One line for the user or the model about what the setup did. */
export function worktreeSetupSummary(setup) {
  if (!setup) return '';
  if (setup.skipped) return setup.output;
  if (setup.ok) return 'Ran worktree setup from ' + setup.source + ' (' + setup.ran + ' step' + (setup.ran === 1 ? '' : 's') + ').';
  return 'Worktree setup from ' + setup.source + ' failed' + (setup.failed ? ' at `' + setup.failed + '`' : '') + (setup.exitCode !== undefined ? ' (exit ' + setup.exitCode + ')' : '') + ': ' + String(setup.output || '').split('\n').slice(-5).join(' ').slice(0, 400);
}
