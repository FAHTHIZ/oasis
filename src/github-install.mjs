// /install-github-app: set up the Oasis GitHub Action in this repository (Claude Code's
// /install-github-app). Writes .github/workflows/oasis.yml and prints the secret step.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

export function githubRepoFromRemote(url) {
  const match = String(url || '').trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return match ? match[1] + '/' + match[2] : null;
}

async function allowedTools(root) {
  const rules = [];
  try {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const runner = existsSync(path.join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(path.join(root, 'yarn.lock')) ? 'yarn' : 'npm';
    for (const script of ['test', 'lint', 'build', 'typecheck']) {
      if (pkg.scripts && pkg.scripts[script]) rules.push('Bash(' + runner + (script === 'test' && runner === 'npm' ? ' test' : ' run ' + script) + ':*)');
    }
  } catch {}
  if (existsSync(path.join(root, 'pyproject.toml')) || existsSync(path.join(root, 'pytest.ini'))) rules.push('Bash(pytest:*)');
  if (existsSync(path.join(root, 'Cargo.toml'))) rules.push('Bash(cargo test:*)', 'Bash(cargo build:*)');
  if (existsSync(path.join(root, 'go.mod'))) rules.push('Bash(go test:*)', 'Bash(go build:*)');
  return rules;
}

export async function githubInstallPlan(root, config = {}, options = {}) {
  const remote = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, encoding: 'utf8' });
  const repo = githubRepoFromRemote(remote.stdout);
  const protocol = config.protocol || 'anthropic';
  const model = config.model || 'claude-sonnet-5';
  const trigger = options.trigger || '@oasis';
  const tools = await allowedTools(root);
  const file = path.join(root, '.github', 'workflows', 'oasis.yml');
  const workflow = [
    '# Installed by /install-github-app. Mention ' + trigger + ' on an issue or pull request.',
    '# Needs a repository secret named OASIS_API_KEY with your provider key.',
    'name: Oasis',
    'on:',
    '  issue_comment:',
    '    types: [created]',
    '  pull_request_review_comment:',
    '    types: [created]',
    '  pull_request_review:',
    '    types: [submitted]',
    '  issues:',
    '    types: [opened, assigned, labeled]',
    'permissions:',
    '  contents: write',
    '  issues: write',
    '  pull-requests: write',
    'jobs:',
    '  oasis:',
    "    if: contains(github.event.comment.body || github.event.review.body || github.event.issue.body || '', '" + trigger.replace(/'/g, "''") + "') || github.event.action == 'assigned' || github.event.action == 'labeled'",
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 30',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          fetch-depth: 0',
    '      - uses: FAHTHIZ/oasis@main',
    '        with:',
    '          api_key: ${{ secrets.OASIS_API_KEY }}',
    '          protocol: ' + protocol,
    ...(config.baseURL && protocol !== 'anthropic' && !/api\.openai\.com/.test(config.baseURL) ? ['          base_url: ' + config.baseURL] : []),
    '          model: ' + model,
    ...(trigger !== '@oasis' ? ['          trigger_phrase: ' + JSON.stringify(trigger)] : []),
    ...(tools.length ? ['          allowed_tools: ' + JSON.stringify(tools.join(','))] : []),
    ''
  ].join('\n');
  return { root, repo, file, exists: existsSync(file), workflow, protocol, model, tools };
}

export function describeInstallPlan(plan) {
  const lines = ['Repository: ' + (plan.repo || '(no GitHub origin remote found)'), 'Workflow: ' + path.relative(plan.root, plan.file) + (plan.exists ? ' (exists; pass force to overwrite)' : ''), 'Provider: ' + plan.protocol + ' / ' + plan.model];
  if (plan.tools.length) lines.push('Allowed without asking in CI: ' + plan.tools.join(', '));
  return lines.join('\n');
}

export async function writeInstallPlan(plan) {
  await mkdir(path.dirname(plan.file), { recursive: true });
  await writeFile(plan.file, plan.workflow);
  const repoFlag = plan.repo ? ' --repo ' + plan.repo : '';
  return [
    'Wrote ' + path.relative(plan.root, plan.file) + '.',
    'Next steps:',
    '  1. Add your provider key as a secret:  gh secret set OASIS_API_KEY' + repoFlag + '  (it prompts for the value)',
    '  2. Commit and push the workflow:      git add .github/workflows/oasis.yml && git commit -m "Add Oasis GitHub Action" && git push',
    '  3. Mention @oasis in an issue or PR comment.',
    'Docs: docs/github-action.md'
  ].join('\n');
}
