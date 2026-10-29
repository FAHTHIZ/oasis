import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { saveConfig } from '../src/config.mjs';
import { compareEvalReports, runEvalCommand, validateEvaluationSuite } from '../src/eval.mjs';

// These scripted fixtures overwrite files without reading them first; read-before-edit
// enforcement is covered by test/file-state.test.mjs.
process.env.OASIS_REQUIRE_READ_BEFORE_EDIT = '0';

async function temporaryDirectory(prefix = 'oasis-eval-test-') {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createFixtureTask(tasksDir, id = 'fixture-task') {
  const taskDir = path.join(tasksDir, id);
  const repoDir = path.join(taskDir, 'repo');
  await mkdir(repoDir, { recursive: true });
  await writeFile(path.join(repoDir, 'demo.txt'), 'old\n');
  await writeFile(path.join(taskDir, 'task.md'),
    'Change demo.txt so it contains exactly the line new followed by a newline. Verify your change.\n');
  await writeFile(path.join(taskDir, 'reference.patch'), [
    'diff --git a/demo.txt b/demo.txt',
    '--- a/demo.txt',
    '+++ b/demo.txt',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    ''
  ].join('\n'));
  await writeFile(path.join(taskDir, 'verify.mjs'), [
    "import assert from 'node:assert/strict';",
    "import path from 'node:path';",
    "import { readFile } from 'node:fs/promises';",
    "const content = await readFile(path.join(process.argv[2], 'demo.txt'), 'utf8');",
    "assert.equal(content, 'new\\n');",
    ''
  ].join('\n'));
  return taskDir;
}

test('eval suite validation requires no-op failure and reference-patch success', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const tasksDir = path.join(tmp, 'tasks');
  await mkdir(tasksDir);
  await createFixtureTask(tasksDir);
  const report = await validateEvaluationSuite({ tasksDir, env: { ...process.env } });
  assert.equal(report.ok, true, JSON.stringify(report.results));
  assert.equal(report.total, 1);
  assert.equal(report.results[0].ok, true);
  assert.notEqual(report.results[0].noOpExitCode, 0);
  assert.equal(report.results[0].referenceExitCode, 0);
});

test('eval suite rejects a task whose verifier passes unchanged', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const tasksDir = path.join(tmp, 'tasks');
  await mkdir(tasksDir);
  const taskDir = await createFixtureTask(tasksDir, 'bad-task');
  await writeFile(path.join(taskDir, 'verify.mjs'), [
    "process.exit(0);",
    ''
  ].join('\n'));
  const report = await validateEvaluationSuite({ tasksDir, env: { ...process.env } });
  assert.equal(report.ok, false);
  assert.match(report.results[0].error, /No-op check failed/);
});

test('model eval runs in a disposable copy and records result metrics as JSON', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const configDir = path.join(tmp, 'user-config');
  const resultsDir = path.join(tmp, 'eval-results');
  const tasksDir = path.join(tmp, 'tasks');
  await mkdir(tasksDir);
  const taskDir = await createFixtureTask(tasksDir);
  let requests = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString('utf8');
    requests++;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (requests === 1) {
      const request = JSON.parse(raw);
      assert.ok(Array.isArray(request.tools));
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'eval-write-1',
              type: 'function',
              function: { name: 'write_file', arguments: JSON.stringify({ path: 'demo.txt', content: 'new\n' }) }
            }]
          }
        }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
      }));
    } else if (requests === 2) {
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Updated and verified.' } }],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 }
      }));
    } else if (requests === 3) {
      const request = JSON.parse(raw);
      assert.ok(request.messages.some((message) => message.role === 'user' && String(message.content).includes('post-edit verification gate')));
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: 'I will reread the changed text file because this fixture is not a Git repository.',
            tool_calls: [{
              id: 'eval-review-1',
              type: 'function',
              function: { name: 'read_file', arguments: JSON.stringify({ path: 'demo.txt' }) }
            }]
          }
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      }));
    } else {
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'I reread demo.txt and verified the updated contents.' } }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const env = {
    ...process.env,
    OASIS_CONFIG_DIR: configDir,
    OASIS_EVAL_INPUT_USD_PER_MILLION_TOKENS: '1',
    OASIS_EVAL_OUTPUT_USD_PER_MILLION_TOKENS: '2'
  };
  await saveConfig({
    protocol: 'openai-compatible',
    baseURL: 'http://127.0.0.1:' + server.address().port + '/v1',
    model: 'fixture-model',
    apiKey: '',
    maxSteps: 4
  }, { env });

  const output = { text: '', write(value) { this.text += String(value); } };
  const result = await runEvalCommand(['--task', 'fixture-task', '--trials', '1'], {
    autoApprove: true,
    env,
    tasksDir,
    resultsDir,
    output
  });

  assert.equal(result.ok, true, output.text);
  assert.equal(result.summary.passed, 1);
  assert.equal(result.summary.failed, 0);
  assert.equal(result.results[0].status, 'passed');
  assert.equal(result.results[0].inputTokens, 18);
  assert.equal(result.results[0].outputTokens, 5);
  assert.ok(result.results[0].costUSD > 0);
  assert.match(result.resultsPath, /eval-results/);
  const stored = JSON.parse(await readFile(result.resultsPath, 'utf8'));
  assert.equal(stored.provider.model, 'fixture-model');
  assert.equal(stored.results[0].taskId, 'fixture-task');
  assert.equal(stored.results[0].verification.exitCode, 0);
  const original = await readFile(path.join(taskDir, 'repo', 'demo.txt'), 'utf8');
  assert.equal(original, 'old\n', 'the agent must only modify the disposable workspace');
  assert.equal(requests, 4);
});


test('eval suite rejects symlinked task files and patches that target secrets', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const tasksDir = path.join(tmp, 'tasks');
  await mkdir(tasksDir);

  const linkedTask = await createFixtureTask(tasksDir, 'linked-task');
  const externalPatch = path.join(tmp, 'external.patch');
  await writeFile(externalPatch, 'this must not be read as a task patch\n');
  await rm(path.join(linkedTask, 'reference.patch'));
  await symlink(externalPatch, path.join(linkedTask, 'reference.patch'));
  const linkedReport = await validateEvaluationSuite({ tasksDir, env: { ...process.env } });
  assert.equal(linkedReport.ok, false);
  assert.match(linkedReport.results.find((item) => item.id === 'linked-task').error, /reference.patch must be a regular file/);

  const secretTaskDir = path.join(tasksDir, 'secret-patch-task');
  await createFixtureTask(tasksDir, 'secret-patch-task');
  await writeFile(path.join(secretTaskDir, 'reference.patch'), [
    'diff --git a/.env b/.env',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/.env',
    '@@ -0,0 +1 @@',
    '+PRIVATE_TOKEN=not-a-real-secret',
    ''
  ].join('\n'));
  const secretReport = await validateEvaluationSuite({ tasksDir, env: { ...process.env } });
  assert.equal(secretReport.ok, false);
  assert.match(secretReport.results.find((item) => item.id === 'secret-patch-task').error, /unsafe or sensitive file path/);
});

test('eval command refuses model execution unless explicitly approved', async () => {
  await assert.rejects(
    runEvalCommand([], { autoApprove: false, env: { ...process.env }, tasksDir: '/definitely-not-used' }),
    /explicitly run oasis eval --yes/
  );
});



test('eval comparison reports matched-task pass rate, median time, and cost', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const aPath = path.join(tmp, 'oasis-run.json');
  const bPath = path.join(tmp, 'external-run.json');
  await writeFile(aPath, JSON.stringify({
    provider: { model: 'fixture-model-a' },
    results: [
      { taskId: 'fix-a', status: 'passed', wallTimeMs: 100, costUSD: 0.01 },
      { taskId: 'fix-a', status: 'failed', wallTimeMs: 120, costUSD: 0.02 },
      { taskId: 'fix-b', status: 'passed', wallTimeMs: 200, costUSD: 0.01 },
      { taskId: 'only-a', status: 'passed', wallTimeMs: 50, costUSD: 0.01 }
    ]
  }));
  await writeFile(bPath, JSON.stringify({
    label: 'Claude Code baseline',
    results: [
      { taskId: 'fix-a', status: 'passed', wallTimeMs: 90, costUSD: 0.02 },
      { taskId: 'fix-a', status: 'passed', wallTimeMs: 95, costUSD: 0.02 },
      { taskId: 'fix-a', status: 'passed', wallTimeMs: 100, costUSD: 0.02 },
      { taskId: 'fix-b', status: 'failed', wallTimeMs: 300, costUSD: 0.02 },
      { taskId: 'fix-b', status: 'failed', wallTimeMs: 310, costUSD: 0.02 },
      { taskId: 'fix-b', status: 'passed', wallTimeMs: 320, costUSD: 0.02 },
      { taskId: 'only-b', status: 'passed', wallTimeMs: 1, costUSD: 0.001 }
    ]
  }));
  const output = { text: '', write(value) { this.text += String(value); } };
  const result = await runEvalCommand(['--compare', aPath, bPath], {
    env: { ...process.env }, output
  });

  assert.equal(result.ok, true, output.text);
  assert.equal(result.comparison.commonTaskCount, 2);
  assert.deepEqual(result.comparison.onlyInA, ['only-a']);
  assert.deepEqual(result.comparison.onlyInB, ['only-b']);
  assert.equal(result.comparison.sources[1].label, 'Claude Code baseline');
  assert.equal(result.comparison.metrics.a.taskBalancedPassRate, 0.75);
  assert.ok(Math.abs(result.comparison.metrics.b.taskBalancedPassRate - (2 / 3)) < 1e-9);
  assert.ok(Math.abs(result.comparison.metrics.deltaBMinusA.taskBalancedPassRatePercentagePoints - (-100 / 12)) < 1e-6);
  assert.equal(result.comparison.tasks[0].left.medianWallTimeMs, 110);
  assert.equal(result.comparison.tasks[0].right.medianWallTimeMs, 95);
  assert.equal(result.comparison.metrics.a.meanCostPerTrialUSD, 0.0125);
  assert.equal(result.comparison.metrics.b.meanCostPerTrialUSD, 0.02);
  assert.match(output.text, /Evaluation comparison \(matched tasks only\)/);
  assert.match(output.text, /Task-level outcomes/);
  assert.match(output.text, /unmatched task IDs are excluded/);
});

test('eval comparison refuses unsafe files, invalid result rows and disjoint task sets', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const aPath = path.join(tmp, 'a.json');
  const bPath = path.join(tmp, 'b.json');
  await writeFile(aPath, JSON.stringify({ label: 'A', results: [{ taskId: 'task-a', status: 'passed' }] }));
  await writeFile(bPath, JSON.stringify({ label: 'B', results: [{ taskId: 'task-b', status: 'failed' }] }));
  await assert.rejects(compareEvalReports([aPath, bPath]), /no matching task IDs/);

  await writeFile(bPath, JSON.stringify({ results: [{ taskId: '../bad', status: 'passed' }] }));
  await assert.rejects(compareEvalReports([aPath, bPath]), /invalid taskId/);

  const linkPath = path.join(tmp, 'linked.json');
  await symlink(aPath, linkPath);
  await assert.rejects(compareEvalReports([linkPath, bPath]), /regular, non-symlink file/);
});

test('eval comparison requires exactly two report paths and rejects conflicting CLI options', async () => {
  await assert.rejects(
    runEvalCommand(['--compare', 'only-one.json'], { env: { ...process.env } }),
    /requires two JSON report paths/
  );
  await assert.rejects(
    runEvalCommand(['--compare', 'a.json', 'b.json', '--task', 'fix-a'], { env: { ...process.env } }),
    /cannot be combined with --task or --trials/
  );
});
