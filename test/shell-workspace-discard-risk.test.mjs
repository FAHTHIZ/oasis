import test from 'node:test';
import assert from 'node:assert/strict';
import { shellAnalyzerReady, analyzeShellLine } from '../src/shell-risk.mjs';
import { analyzeCommand } from '../src/permissions.mjs';

// run_shell judged these as ordinary commands, so bypass mode or a broad allow
// rule ran them without asking, while run_command already asked for the git
// ones. A person now confirms each, whichever tool the model uses.
test('wiping the whole workspace or every uncommitted change always needs a person', async () => {
  await shellAnalyzerReady();
  for (const line of ['rm -rf *', 'rm -rf ./*', 'rm -rf .', 'rm -r -f ./', 'rm --recursive --force *', 'git checkout -- .', 'git checkout .', 'git checkout -f main', 'git restore .', 'git restore -- :/', 'git switch --discard-changes main', 'git switch -f main', 'git stash clear', 'npm test && git checkout .']) {
    assert.ok(analyzeShellLine(line).highRisk, line);
  }
});

test('narrow cleanups and reverts stay ordinary commands', async () => {
  await shellAnalyzerReady();
  for (const line of ['rm -rf dist', 'rm -rf build/*', 'rm -rf node_modules .cache', 'cd dist && rm -rf *', 'git checkout -- src/a.js', 'git checkout main', 'git checkout -b feature', 'git restore src/a.js', 'git restore --staged .', 'git switch main', 'git commit -m "rm -rf * and git checkout ."', 'echo git checkout .']) {
    const result = analyzeShellLine(line);
    assert.ok(!result.highRisk && !result.blocked, line + ' -> ' + JSON.stringify(result));
  }
});

test('run_command and run_shell agree on discarding the working tree', async () => {
  await shellAnalyzerReady();
  for (const [command, ...args] of [['git', 'checkout', '--', '.'], ['git', 'restore', '.']]) {
    assert.ok(analyzeCommand(command, args).highRisk, command + ' ' + args.join(' '));
    assert.ok(analyzeShellLine([command, ...args].join(' ')).highRisk, [command, ...args].join(' '));
  }
});
