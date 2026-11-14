// Cloud agents on GitHub Actions, with handoff in both directions.
//
//   oasis cloud setup              add .github/workflows/oasis-cloud.yml (and say which secret to set)
//   oasis cloud run "TASK"         start an agent on a GitHub runner; it pushes oasis/cloud-ID
//   oasis cloud run --here "TASK"  hand off: push this branch (and uncommitted work) and continue there
//   oasis cloud list | status ID   follow runs
//   oasis cloud pull ID            bring the agent's branch back to this computer
//
// Everything goes through the GitHub CLI (`gh`), so it uses the account you are signed in with.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './atomic-write.mjs';
import { endChildInput } from './node-process.mjs';

export const CLOUD_WORKFLOW = 'oasis-cloud.yml';
// OASIS's own folder is never handed off or counted as local changes.
const NOT_OASIS = ['--', '.', ':(exclude).oasis'];

export function cloudWorkflowYaml({ actionRef = 'FAHTHIZ/oasis@main' } = {}) {
  return `# OASIS cloud agents: \`oasis cloud run "TASK"\` starts this workflow.
# Set the model key once: gh secret set OASIS_API_KEY
# Optional repository variables: OASIS_PROTOCOL, OASIS_BASE_URL, OASIS_MODEL.
name: OASIS cloud agent
on:
  workflow_dispatch:
    inputs:
      prompt:
        description: What the agent should do
        required: true
      branch:
        description: Branch the agent pushes its work to
        required: true
      model:
        description: Model ID (empty uses the OASIS_MODEL variable)
        required: false
      pull_request:
        description: Open a pull request when done (true or false)
        default: 'false'
      max_turns:
        description: Maximum agent steps
        default: '60'
permissions:
  contents: write
  pull-requests: write
concurrency:
  group: oasis-cloud-\${{ inputs.branch }}
  cancel-in-progress: false
jobs:
  agent:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: ${actionRef}
        with:
          prompt: \${{ inputs.prompt }}
          branch: \${{ inputs.branch }}
          pull_request: \${{ inputs.pull_request }}
          max_turns: \${{ inputs.max_turns }}
          api_key: \${{ secrets.OASIS_API_KEY }}
          protocol: \${{ vars.OASIS_PROTOCOL }}
          base_url: \${{ vars.OASIS_BASE_URL }}
          model: \${{ inputs.model || vars.OASIS_MODEL }}
`;
}

/** A short, sortable id for a cloud task, used in its branch name. */
function cloudTaskId(now = Date.now(), random = randomBytes(2).toString('hex')) {
  return now.toString(36) + random;
}

export function cloudBranch(id) { return 'oasis/cloud-' + id; }

function run(command, args, { cwd, input, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const message = String(stderr || error.message || '').trim().split('\n').slice(-3).join(' ');
        reject(Object.assign(new Error(message || command + ' failed'), { code: error.code }));
      } else resolve(String(stdout).trim());
    });
    endChildInput(child, input);
  });
}

export function createCloudClient({ cwd = process.cwd(), env = process.env, exec = run } = {}) {
  const gh = (args, options = {}) => exec('gh', args, { cwd, env, ...options }).catch((error) => {
    if (error.code === 'ENOENT') throw new Error('Cloud agents use the GitHub CLI. Install it from https://cli.github.com and run `gh auth login`.');
    throw error;
  });
  const git = (args, extraEnv) => exec('git', args, { cwd, env: extraEnv ? { ...env, ...extraEnv } : env });

  // Kept in the git folder: never committed, stashed or switched away with a branch.
  let stateFile = null;
  async function statePath() {
    if (!stateFile) stateFile = path.join(await git(['rev-parse', '--absolute-git-dir']), 'oasis-cloud-tasks.json');
    return stateFile;
  }
  async function readState() {
    let state;
    try { state = JSON.parse(await readFile(await statePath(), 'utf8')); } catch { state = null; }
    return state && typeof state === 'object' && Array.isArray(state.tasks) ? state : { tasks: [] };
  }
  async function saveTask(task) {
    const state = await readState();
    state.tasks = [task, ...state.tasks.filter((item) => item.id !== task.id)].slice(0, 100);
    // Atomic so a crash mid-write cannot leave a truncated task list.
    await atomicWriteFile(await statePath(), JSON.stringify(state, null, 2) + '\n');
  }
  async function findTask(id) {
    const state = await readState();
    const task = id ? state.tasks.find((item) => item.id === id || item.id.startsWith(id) || item.branch === id) : state.tasks[0];
    if (!task) throw new Error(id ? 'No cloud task ' + id + '. `oasis cloud list` shows them.' : 'No cloud tasks yet. Start one with `oasis cloud run "TASK"`.');
    return task;
  }

  async function setup({ actionRef } = {}) {
    const file = path.join(cwd, '.github', 'workflows', CLOUD_WORKFLOW);
    let existed = false;
    try { await readFile(file); existed = true; } catch {}
    if (!existed) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, cloudWorkflowYaml({ actionRef }));
    }
    return { file, created: !existed };
  }

  async function workflowAvailable() {
    try { await gh(['workflow', 'view', CLOUD_WORKFLOW, '--yaml']); return true; } catch { return false; }
  }

  /**
   * Start a cloud task. With `here`, the current branch and any uncommitted work are
   * pushed first, and the agent continues on that branch (local → cloud handoff).
   */
  async function start(prompt, { here = false, model = '', pullRequest = false, maxTurns = 60, now = Date.now() } = {}) {
    const text = String(prompt || '').trim();
    if (!text) throw new Error('Say what the cloud agent should do: oasis cloud run "TASK"');
    if (!(await workflowAvailable())) throw new Error('This repository has no ' + CLOUD_WORKFLOW + ' on GitHub yet. Run `oasis cloud setup`, commit and push the workflow, and set the key with `gh secret set OASIS_API_KEY`.');
    const id = cloudTaskId(now);
    let branch = cloudBranch(id);
    let ref = '';
    if (here) {
      const current = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
      if (!current || current === 'HEAD') throw new Error('Check out a branch before handing work to the cloud.');
      branch = current === 'main' || current === 'master' ? cloudBranch(id) : current;
      if (await git(['status', '--porcelain', ...NOT_OASIS])) {
        // Work in progress (new files included) travels as a commit on the handoff branch,
        // built in a scratch index, so the working tree and staging area stay as they are.
        const gitDir = await git(['rev-parse', '--absolute-git-dir']);
        const scratch = { GIT_INDEX_FILE: path.join(gitDir, 'oasis-cloud-index-' + id) };
        try {
          await git(['read-tree', 'HEAD'], scratch);
          await git(['add', '-A', ...NOT_OASIS], scratch);
          const tree = await git(['write-tree'], scratch);
          const commit = await git(['commit-tree', tree, '-p', 'HEAD', '-m', 'Work in progress handed to OASIS cloud']);
          await git(['push', '-q', 'origin', commit + ':refs/heads/' + branch]);
        } finally {
          const { rm } = await import('node:fs/promises');
          await rm(scratch.GIT_INDEX_FILE, { force: true });
        }
      } else {
        await git(['push', '-q', 'origin', 'HEAD:refs/heads/' + branch]);
      }
      ref = branch;
    }
    const args = ['workflow', 'run', CLOUD_WORKFLOW, '-f', 'prompt=' + text, '-f', 'branch=' + branch, '-f', 'pull_request=' + (pullRequest ? 'true' : 'false'), '-f', 'max_turns=' + String(maxTurns)];
    if (model) args.push('-f', 'model=' + model);
    if (ref) args.push('--ref', ref);
    await gh(args);
    const task = { id, prompt: text, branch, ref: ref || null, model: model || null, startedAt: new Date(now).toISOString(), runId: null, url: null };
    // The run appears a moment after dispatch; link it if it is already there.
    try {
      const runs = JSON.parse(await gh(['run', 'list', '--workflow', CLOUD_WORKFLOW, '--limit', '5', '--json', 'databaseId,url,createdAt,event']));
      const match = runs.find((item) => item.event === 'workflow_dispatch' && Date.parse(item.createdAt) >= now - 60000);
      if (match) { task.runId = match.databaseId; task.url = match.url; }
    } catch {}
    await saveTask(task);
    return task;
  }

  async function resolveRun(task) {
    if (task.runId) return task;
    const runs = JSON.parse(await gh(['run', 'list', '--workflow', CLOUD_WORKFLOW, '--limit', '30', '--json', 'databaseId,url,createdAt,event,displayTitle']));
    const started = Date.parse(task.startedAt);
    const match = runs.filter((item) => item.event === 'workflow_dispatch' && Date.parse(item.createdAt) >= started - 60000)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
    if (match) { task.runId = match.databaseId; task.url = match.url; await saveTask(task); }
    return task;
  }

  async function status(id) {
    const task = await resolveRun(await findTask(id));
    if (!task.runId) return { ...task, status: 'queued', conclusion: null };
    const view = JSON.parse(await gh(['run', 'view', String(task.runId), '--json', 'status,conclusion,url,updatedAt']));
    return { ...task, status: view.status, conclusion: view.conclusion || null, url: view.url || task.url, updatedAt: view.updatedAt };
  }

  async function list() {
    const state = await readState();
    return Promise.all(state.tasks.slice(0, 20).map((task) => status(task.id).catch(() => ({ ...task, status: 'unknown', conclusion: null }))));
  }

  /** Cloud → local handoff: fetch the agent's branch and check it out here. */
  async function pull(id) {
    const task = await findTask(id);
    if (await git(['status', '--porcelain', ...NOT_OASIS])) throw new Error('Commit or stash your local changes first, so pulling the cloud branch cannot overwrite them.');
    await git(['fetch', '-q', 'origin', 'refs/heads/' + task.branch + ':refs/remotes/origin/' + task.branch]).catch(() => {
      throw new Error('The cloud agent has not pushed ' + task.branch + ' yet. `oasis cloud status ' + task.id + '` shows how it is doing.');
    });
    await git(['checkout', '-q', '-B', task.branch, 'origin/' + task.branch]);
    const log = await git(['log', '--oneline', '-5', 'origin/' + task.branch]);
    return { ...task, log };
  }

  async function logs(id) {
    const task = await resolveRun(await findTask(id));
    if (!task.runId) throw new Error('The run has not started yet.');
    return gh(['run', 'view', String(task.runId), '--log']);
  }

  return { setup, start, status, list, pull, logs, findTask };
}

const HELP = `Cloud agents run OASIS on GitHub Actions and push their work to a branch.

  oasis cloud setup                 Add .github/workflows/${CLOUD_WORKFLOW} to this repository
  oasis cloud run "TASK"            Start a cloud agent (branch oasis/cloud-ID)
      --here                        Hand off this branch, uncommitted work included, and continue there
      --model ID  --pr  --max-turns N
  oasis cloud list                  Recent cloud tasks and their state
  oasis cloud status [ID]           One task (the latest by default)
  oasis cloud logs [ID]             The run's log
  oasis cloud pull [ID]             Check out the agent's branch here to keep working locally

Uses the GitHub CLI (gh). The model key is the repository secret OASIS_API_KEY; the
variables OASIS_PROTOCOL, OASIS_BASE_URL and OASIS_MODEL choose the provider.
`;

function stateLabel(task) {
  if (task.conclusion) return task.conclusion === 'success' ? 'done' : task.conclusion;
  return task.status === 'in_progress' ? 'working' : task.status || 'queued';
}

export async function cloudCommand(args, { cwd = process.cwd(), env = process.env, stdout = process.stdout, client = createCloudClient({ cwd, env }) } = {}) {
  const [sub, ...rest] = args;
  const flag = (name) => { const i = rest.indexOf(name); if (i < 0) return null; const [, value] = rest.splice(i, 2); return value ?? ''; };
  const bool = (name) => { const i = rest.indexOf(name); if (i < 0) return false; rest.splice(i, 1); return true; };
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') { stdout.write(HELP); return 0; }
  if (sub === 'setup') {
    const { file, created } = await client.setup({ actionRef: flag('--action') || undefined });
    stdout.write((created ? 'Added ' : 'Already there: ') + path.relative(cwd, file) + '\n' +
      'Next: commit and push it, then set your model key with `gh secret set OASIS_API_KEY`.\n' +
      'Pick the provider with `gh variable set OASIS_PROTOCOL`, `OASIS_BASE_URL` and `OASIS_MODEL` if it is not OpenAI.\n');
    return 0;
  }
  if (sub === 'run' || sub === 'start') {
    const here = bool('--here');
    const pullRequest = bool('--pr');
    const model = flag('--model') || '';
    const maxTurns = Number(flag('--max-turns')) || 60;
    const task = await client.start(rest.join(' '), { here, model, pullRequest, maxTurns });
    stdout.write('Cloud agent ' + task.id + ' started on ' + task.branch + '.\n' + (task.url ? 'Follow it: ' + task.url + '\n' : '') +
      'When it is done: oasis cloud pull ' + task.id + '\n');
    return 0;
  }
  if (sub === 'list' || sub === 'ls') {
    const tasks = await client.list();
    if (!tasks.length) { stdout.write('No cloud tasks yet. Start one with `oasis cloud run "TASK"`.\n'); return 0; }
    for (const task of tasks) stdout.write(task.id.padEnd(12) + stateLabel(task).padEnd(11) + task.branch.padEnd(28) + task.prompt.replace(/\s+/g, ' ').slice(0, 60) + '\n');
    return 0;
  }
  if (sub === 'status') {
    const task = await client.status(rest[0]);
    stdout.write(task.id + ': ' + stateLabel(task) + '\nBranch: ' + task.branch + '\nTask: ' + task.prompt + '\n' + (task.url ? 'Run: ' + task.url + '\n' : ''));
    return 0;
  }
  if (sub === 'logs') { stdout.write((await client.logs(rest[0])) + '\n'); return 0; }
  if (sub === 'pull') {
    const task = await client.pull(rest[0]);
    stdout.write('Checked out ' + task.branch + ' with the cloud agent\'s work:\n' + task.log + '\nContinue here with `oasis --continue` or a new task.\n');
    return 0;
  }
  stdout.write('Unknown cloud command "' + sub + '".\n\n' + HELP);
  return 1;
}
