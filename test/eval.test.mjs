import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { saveConfig } from '../src/config.mjs';
import { compareEvalReports, runEvalCommand, runEvalProcess, validateEvaluationSuite } from '../src/eval.mjs';

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

test('evaluation subprocess timeout terminates descendants that inherit output pipes', async (t) => {
  if (process.platform === 'win32') {
    t.skip('The process-group assertion is POSIX-specific; Windows uses taskkill tree termination.');
    return;
  }
  const startedAt = Date.now();
  const source = [
    "const { spawn } = require('node:child_process');",
    "spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 6500); setInterval(() => {}, 250);'], { stdio: 'inherit' });",
    "process.stdout.write('descendant-started\\n');",
    "setInterval(() => {}, 250);"
  ].join('\n');
  const result = await runEvalProcess(process.execPath, ['-e', source], {
    env: { PATH: process.env.PATH || '' },
    timeoutMs: 1000,
    outputLimit: 2048
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
  assert.match(result.output, /descendant-started/);
  assert.ok(elapsedMs < 4500, 'the evaluator should terminate the process group instead of waiting for a child-held pipe (elapsed ' + elapsedMs + 'ms)');
});

test('evaluation timeout escalates after its leader exits and a descendant ignores SIGTERM', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('This descendant-state assertion uses Linux /proc.');
    return;
  }
  const tmp = await temporaryDirectory('oasis-eval-tree-escalation-');
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const readyPath = path.join(tmp, 'descendant.ready');
  const pidPath = path.join(tmp, 'descendant.pid');
  const descendantSource = [
    "process.on('SIGTERM', () => {});",
    "require('node:fs').writeFileSync(process.env.OASIS_TEST_READY_FILE, 'ready');",
    "setInterval(() => {}, 1000);"
  ].join('\n');
  const source = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', " + JSON.stringify(descendantSource) + "], { stdio: 'ignore', env: process.env });",
    "const publish = setInterval(() => { if (fs.existsSync(process.env.OASIS_TEST_READY_FILE)) { clearInterval(publish); fs.writeFileSync(process.env.OASIS_TEST_PID_FILE, String(child.pid)); } }, 10);",
    "setInterval(() => {}, 1000);"
  ].join('\n');
  const startedAt = Date.now();
  let descendantPid = 0;
  try {
    const result = await runEvalProcess(process.execPath, ['-e', source], {
      cwd: tmp,
      env: { PATH: process.env.PATH || '', OASIS_TEST_READY_FILE: readyPath, OASIS_TEST_PID_FILE: pidPath },
      timeoutMs: 1000,
      outputLimit: 2048
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 124);
    const pidDeadline = Date.now() + 1000;
    while (!descendantPid && Date.now() < pidDeadline) {
      try { descendantPid = Number((await readFile(pidPath, 'utf8')).trim()); } catch {}
      if (!descendantPid) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(descendantPid > 0, 'the child must install its SIGTERM handler before its PID is published');
    assert.equal(await readFile(readyPath, 'utf8'), 'ready');

    const running = async () => {
      try {
        const stat = await readFile('/proc/' + descendantPid + '/stat', 'utf8');
        const end = stat.lastIndexOf(')');
        return stat.slice(end + 2, end + 3) !== 'Z';
      } catch (error) {
        if (error && error.code === 'ENOENT') return false;
        try { process.kill(descendantPid, 0); return true; }
        catch (signalError) { return signalError && signalError.code === 'EPERM'; }
      }
    };
    const stopDeadline = Date.now() + 5000;
    while (await running() && Date.now() < stopDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(Date.now() - startedAt >= 1800, 'the test should exercise the delayed SIGKILL escalation');
    assert.equal(await running(), false, 'the stubborn descendant must be gone after escalation');
  } finally {
    if (descendantPid > 0) { try { process.kill(descendantPid, 'SIGKILL'); } catch {} }
  }
});

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
  assert.match(report.results[0].taskFingerprint, /^[a-f0-9]{64}$/);
  assert.notEqual(report.results[0].noOpExitCode, 0);
  assert.equal(report.results[0].referenceExitCode, 0);
});

test('eval negative control passes only when unchanged snapshots stay below the strict 10% threshold', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const tasksDir = path.join(tmp, 'tasks');
  await mkdir(tasksDir);
  await createFixtureTask(tasksDir, 'negative-control-task');
  const output = { text: '', write(value) { this.text += String(value); } };

  const result = await runEvalCommand(['--negative-control'], {
    tasksDir, env: { ...process.env }, output
  });

  assert.equal(result.ok, true, output.text);
  assert.equal(result.negativeControl.referencePasses, 1);
  assert.equal(result.negativeControl.referencePassRate, 1);
  assert.equal(result.negativeControl.noOpPasses, 0);
  assert.equal(result.negativeControl.total, 1);
  assert.equal(result.negativeControl.passRate, 0);
  assert.equal(result.negativeControl.threshold, 0.10);
  assert.equal(result.negativeControl.strictlyWorse, true);
  assert.equal(result.negativeControl.fixturesValid, true);
  assert.match(output.text, /required: below 10%/);
});

test('eval negative control fails when an unchanged fixture is accepted', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const tasksDir = path.join(tmp, 'tasks');
  await mkdir(tasksDir);
  const taskDir = await createFixtureTask(tasksDir, 'broken-negative-control');
  await writeFile(path.join(taskDir, 'verify.mjs'), 'process.exit(0);\n');
  const output = { text: '', write(value) { this.text += String(value); } };

  const result = await runEvalCommand(['--negative-control'], {
    tasksDir, env: { ...process.env }, output
  });

  assert.equal(result.ok, false);
  assert.equal(result.negativeControl.referencePasses, 0);
  assert.equal(result.negativeControl.referencePassRate, 0);
  assert.equal(result.negativeControl.noOpPasses, 1);
  assert.equal(result.negativeControl.passRate, 1);
  assert.equal(result.negativeControl.strictlyWorse, false);
  assert.equal(result.negativeControl.fixturesValid, false);
  assert.match(output.text, /Evaluation negative control: FAIL/);
});

test('OASIS eval records selected routed model, per-task cost and savings', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const configDir = path.join(tmp, 'user-config');
  const resultsDir = path.join(tmp, 'eval-results');
  const tasksDir = path.join(tmp, 'tasks');
  await mkdir(tasksDir);
  const taskDir = await createFixtureTask(tasksDir);
  await writeFile(path.join(tasksDir, 'metadata.json'), JSON.stringify({
    schemaVersion: 1,
    categories: { 'utility-logic': 'Read-only fixture category.' },
    difficulties: ['small', 'medium', 'large'],
    tasks: {
      'fixture-task': { category: 'utility-logic', difficulty: 'small', rationale: 'Use the cheap model for a clearly small task.' }
    }
  }));
  let capturedSessionRouting = null;
  let capturedHint = null;
  const env = {
    ...process.env,
    OASIS_CONFIG_DIR: configDir,
    GITHUB_SHA: 'd'.repeat(40)
  };
  await saveConfig({
    protocol: 'openai-compatible',
    baseURL: 'http://127.0.0.1:1/v1',
    model: 'strong-model',
    apiKey: '',
    maxSteps: 4
  }, { env });

  const output = { text: '', write(value) { this.text += String(value); } };
  const result = await runEvalCommand([
    '--task', 'fixture-task',
    '--trials', '1',
    '--route-easy-model', 'cheap-model',
    '--route-strong-model', 'strong-model'
  ], {
    autoApprove: true,
    env,
    tasksDir,
    resultsDir,
    output,
    agentRunner: async (session, _prompt, options) => {
      capturedSessionRouting = { ...session.settings.modelRouting };
      capturedHint = options.routingHint;
      await writeFile(path.join(session.root, 'demo.txt'), 'new\n');
      return {
        finished: true,
        toolCalls: 1,
        modelRouting: {
          enabled: true,
          tier: 'easy',
          selectedModel: 'cheap-model',
          strongModel: 'strong-model',
          reason: 'benchmark task marked small'
        },
        taskUsage: {
          inputTokens: 1000,
          outputTokens: 200,
          totalTokens: 1200,
          costUSD: 0.001,
          strongModelCostUSD: 0.004,
          savingsUSD: 0.003,
          costKnown: true,
          strongModelCostKnown: true
        }
      };
    }
  });

  assert.equal(result.ok, true, output.text);
  assert.deepEqual(capturedSessionRouting, {
    enabled: true,
    easyModel: 'cheap-model',
    strongModel: 'strong-model'
  });
  assert.equal(capturedHint, 'small');
  assert.equal(result.results[0].model, 'cheap-model');
  assert.equal(result.results[0].requestedModel, 'strong-model');
  assert.equal(result.results[0].routeTier, 'easy');
  assert.equal(result.results[0].costUSD, 0.001);
  assert.equal(result.results[0].strongModelCostUSD, 0.004);
  assert.equal(result.results[0].routingSavingsUSD, 0.003);
  assert.equal(result.results[0].costSource, 'per-model pricing estimate');
  assert.equal(result.summary.routing.enabled, true);
  assert.equal(result.summary.routing.easyModel, 'cheap-model');
  assert.match(output.text, /easy\/cheap-model/);
  assert.match(output.text, /saved vs strong \$0\.003000/);

  const stored = JSON.parse(await readFile(result.resultsPath, 'utf8'));
  assert.equal(stored.results[0].model, 'cheap-model');
  assert.equal(stored.results[0].routingSavingsUSD, 0.003);
  assert.equal(stored.routing.strongModel, 'strong-model');
});

test('evaluation metadata is validated and becomes part of task fingerprints', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const tasksDir = path.join(tmp, 'tasks');
  await mkdir(tasksDir);
  await createFixtureTask(tasksDir);

  const manifestPath = path.join(tasksDir, 'metadata.json');
  const manifest = {
    schemaVersion: 1,
    categories: { 'utility-logic': 'Deterministic helpers.', 'security-boundaries': 'Security checks.' },
    difficulties: ['small', 'medium', 'large'],
    tasks: {
      'fixture-task': { category: 'security-boundaries', difficulty: 'medium', rationale: 'Fixture for metadata provenance.' }
    }
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const first = await validateEvaluationSuite({ tasksDir, env: { ...process.env } });
  assert.equal(first.ok, true, JSON.stringify(first.results));
  assert.equal(first.results[0].category, 'security-boundaries');
  assert.equal(first.results[0].difficulty, 'medium');
  const originalFingerprint = first.results[0].taskFingerprint;

  manifest.tasks['fixture-task'] = {
    category: 'utility-logic', difficulty: 'small', rationale: 'Reclassified after review.'
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const second = await validateEvaluationSuite({ tasksDir, env: { ...process.env } });
  assert.equal(second.ok, true, JSON.stringify(second.results));
  assert.notEqual(second.results[0].taskFingerprint, originalFingerprint, 'metadata changes must invalidate task fingerprints');

  manifest.tasks['fixture-task'].category = 'unknown-category';
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const invalid = await validateEvaluationSuite({ tasksDir, env: { ...process.env } });
  assert.equal(invalid.ok, false);
  assert.match(invalid.results[0].error, /unknown category/);
});

test('eval tasks support reusable named repository snapshots with safe IDs', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const tasksDir = path.join(tmp, 'tasks');
  const snapshotsDir = path.join(tmp, 'snapshots');
  await mkdir(tasksDir);
  const taskDir = await createFixtureTask(tasksDir, 'shared-snapshot-task');
  const taskRepo = path.join(taskDir, 'repo');
  await rm(taskRepo, { recursive: true, force: true });
  await mkdir(taskRepo);
  await writeFile(path.join(taskRepo, 'BASE_SNAPSHOT'), 'fixture-repo\n');

  const snapshot = path.join(snapshotsDir, 'fixture-repo');
  await mkdir(snapshot, { recursive: true });
  await writeFile(path.join(snapshot, 'demo.txt'), 'old\n');

  const report = await validateEvaluationSuite({
    tasksDir,
    snapshotsDir,
    env: { ...process.env }
  });
  assert.equal(report.ok, true, JSON.stringify(report.results));
  assert.equal(report.results[0].id, 'shared-snapshot-task');
  assert.equal(report.results[0].ok, true);

  await writeFile(path.join(taskRepo, 'BASE_SNAPSHOT'), '../escape\n');
  const unsafe = await validateEvaluationSuite({
    tasksDir,
    snapshotsDir,
    env: { ...process.env }
  });
  assert.equal(unsafe.ok, false);
  assert.match(unsafe.results[0].error, /invalid shared repository snapshot ID/);
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
    GITHUB_SHA: 'a'.repeat(40),
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
  assert.equal(result.summary.sourceRevision, 'a'.repeat(40));
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
    sourceRevision: 'c'.repeat(40),
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
  assert.deepEqual(result.comparison.pairedTaskOutcomes, { aWins: 1, bWins: 1, ties: 0 });
  assert.ok(result.comparison.caveats.some((item) => /targets at least 50 representative tasks/.test(item)));
  assert.ok(result.comparison.caveats.some((item) => /no verified 40-character source revision/.test(item)));
  assert.deepEqual(result.comparison.onlyInA, ['only-a']);
  assert.deepEqual(result.comparison.onlyInB, ['only-b']);
  assert.equal(result.comparison.sources[1].label, 'Claude Code baseline');
  assert.equal(result.comparison.sources[0].revision, 'c'.repeat(40));
  assert.equal(result.comparison.sources[1].revision, null, 'reports without a revision remain explicitly unpinned');
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

test('eval comparison exports private JSON and self-contained escaped HTML reports', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const aPath = path.join(tmp, 'oasis-run.json');
  const bPath = path.join(tmp, 'external-run.json');
  const jsonPath = path.join(tmp, 'reports', 'arena.json');
  const htmlPath = path.join(tmp, 'reports', 'arena.html');
  const fingerprint = 'a'.repeat(64);
  const rowsA = [
    { taskId: 'cross-module-task', taskFingerprint: fingerprint, category: 'configuration-integration', difficulty: 'large', status: 'passed', wallTimeMs: 120, costUSD: 0.02 },
    { taskId: 'cross-module-task', taskFingerprint: fingerprint, category: 'configuration-integration', difficulty: 'large', status: 'failed', wallTimeMs: 150, costUSD: 0.02 },
    { taskId: 'cross-module-task', taskFingerprint: fingerprint, category: 'configuration-integration', difficulty: 'large', status: 'passed', wallTimeMs: 110, costUSD: 0.02 }
  ];
  const rowsB = [
    { taskId: 'cross-module-task', taskFingerprint: fingerprint, category: 'configuration-integration', difficulty: 'large', status: 'passed', wallTimeMs: 90, costUSD: 0.01 },
    { taskId: 'cross-module-task', taskFingerprint: fingerprint, category: 'configuration-integration', difficulty: 'large', status: 'passed', wallTimeMs: 95, costUSD: 0.01 },
    { taskId: 'cross-module-task', taskFingerprint: fingerprint, category: 'configuration-integration', difficulty: 'large', status: 'passed', wallTimeMs: 100, costUSD: 0.01 }
  ];
  await writeFile(aPath, JSON.stringify({ label: 'OASIS', sourceRevision: 'a'.repeat(40), results: rowsA }));
  await writeFile(bPath, JSON.stringify({ label: '<script>alert(1)</script>', sourceRevision: 'b'.repeat(40), results: rowsB }));
  // Existing regular artifacts are replaced atomically, not left partially written.
  await mkdir(path.dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, 'stale JSON report\n');
  await writeFile(htmlPath, 'stale HTML report\n');
  const output = { text: '', write(value) { this.text += String(value); } };
  const result = await runEvalCommand([
    '--compare', aPath, bPath, '--out', jsonPath, '--html', htmlPath
  ], { env: { ...process.env }, output });

  assert.equal(result.ok, true, output.text);
  assert.equal(result.jsonReportPath, path.resolve(jsonPath));
  assert.equal(result.htmlReportPath, path.resolve(htmlPath));
  assert.deepEqual(result.comparison.pairedTaskOutcomes, { aWins: 0, bWins: 1, ties: 0 });
  assert.equal(result.comparison.caveats.some((item) => /no matched task is labeled large/.test(item)), false);
  const saved = JSON.parse(await readFile(jsonPath, 'utf8'));
  assert.equal(saved.schemaVersion, 1);
  assert.deepEqual(saved.pairedTaskOutcomes, { aWins: 0, bWins: 1, ties: 0 });
  const html = await readFile(htmlPath, 'utf8');
  assert.match(html, /OASIS Arena comparison/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<script\b/i, 'the static report must not execute embedded JavaScript');
  if (process.platform !== 'win32') {
    assert.equal((await stat(jsonPath)).mode & 0o777, 0o600);
    assert.equal((await stat(htmlPath)).mode & 0o777, 0o600);
  }
});

test('comparison artifact refuses symlink outputs without changing the target', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const reports = path.join(tmp, 'reports');
  await mkdir(reports);
  const aPath = path.join(tmp, 'a.json');
  const bPath = path.join(tmp, 'b.json');
  const target = path.join(tmp, 'protected.html');
  const linkedOutput = path.join(reports, 'comparison.html');
  const run = { results: [{ taskId: 'task-one', status: 'passed' }] };
  await writeFile(aPath, JSON.stringify({ ...run, label: 'A' }));
  await writeFile(bPath, JSON.stringify({ ...run, label: 'B' }));
  await writeFile(target, 'do not overwrite\\n');
  try {
    await symlink(target, linkedOutput);
  } catch (error) {
    t.skip('symlinks are unavailable in this environment: ' + error.message);
    return;
  }

  const output = { text: '', write(value) { this.text += String(value); } };
  await assert.rejects(
    runEvalCommand(['--compare', aPath, bPath, '--html', linkedOutput], { env: { ...process.env }, output }),
    /regular, non-symlink file/
  );
  assert.equal(await readFile(target, 'utf8'), 'do not overwrite\\n');
  assert.equal(await readFile(linkedOutput, 'utf8'), 'do not overwrite\\n');
});

test('comparison reports category-balanced rates separately from task-balanced rates', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const aPath = path.join(tmp, 'a-labelled.json');
  const bPath = path.join(tmp, 'b-labelled.json');
  const rowsA = [
    { taskId: 'utility-one', taskFingerprint: 'a'.repeat(64), category: 'utility-logic', difficulty: 'small', status: 'passed', wallTimeMs: 100, costUSD: 0.01 },
    { taskId: 'utility-two', taskFingerprint: 'b'.repeat(64), category: 'utility-logic', difficulty: 'small', status: 'passed', wallTimeMs: 110, costUSD: 0.01 },
    { taskId: 'config-one', taskFingerprint: 'c'.repeat(64), category: 'configuration-integration', difficulty: 'medium', status: 'failed', wallTimeMs: 300, costUSD: 0.02 }
  ];
  const rowsB = [
    { taskId: 'utility-one', taskFingerprint: 'a'.repeat(64), category: 'utility-logic', difficulty: 'small', status: 'passed', wallTimeMs: 90, costUSD: 0.01 },
    { taskId: 'utility-two', taskFingerprint: 'b'.repeat(64), category: 'utility-logic', difficulty: 'small', status: 'failed', wallTimeMs: 150, costUSD: 0.01 },
    { taskId: 'config-one', taskFingerprint: 'c'.repeat(64), category: 'configuration-integration', difficulty: 'medium', status: 'passed', wallTimeMs: 250, costUSD: 0.02 }
  ];
  await writeFile(aPath, JSON.stringify({ label: 'OASIS', sourceRevision: 'e'.repeat(40), results: rowsA }));
  await writeFile(bPath, JSON.stringify({ label: 'Baseline', sourceRevision: 'f'.repeat(40), results: rowsB }));
  const output = { text: '', write(value) { this.text += String(value); } };
  const result = await runEvalCommand(['--compare', aPath, bPath], { env: { ...process.env }, output });

  assert.equal(result.ok, true, output.text);
  assert.equal(result.comparison.metrics.a.taskBalancedPassRate, 2 / 3);
  assert.equal(result.comparison.metrics.b.taskBalancedPassRate, 2 / 3);
  assert.equal(result.comparison.metrics.a.categoryBalancedPassRate, 0.5);
  assert.equal(result.comparison.metrics.b.categoryBalancedPassRate, 0.75);
  assert.equal(result.comparison.metrics.deltaBMinusA.categoryBalancedPassRatePercentagePoints, 25);
  assert.deepEqual(result.comparison.categoryBreakdown.map((row) => row.category).sort(), ['configuration-integration', 'utility-logic']);
  assert.match(output.text, /Category-balanced pass rate/);
  assert.match(output.text, /Difficulty-balanced pass rate/);
});

test('comparison rejects a task whose category changes between reports', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const aPath = path.join(tmp, 'a.json');
  const bPath = path.join(tmp, 'b.json');
  const fingerprint = 'a'.repeat(64);
  await writeFile(aPath, JSON.stringify({ results: [{ taskId: 'same-task', taskFingerprint: fingerprint, category: 'utility-logic', difficulty: 'small', status: 'passed' }] }));
  await writeFile(bPath, JSON.stringify({ results: [{ taskId: 'same-task', taskFingerprint: fingerprint, category: 'configuration-integration', difficulty: 'small', status: 'passed' }] }));
  await assert.rejects(
    runEvalCommand(['--compare', aPath, bPath], { env: { ...process.env } }),
    /no matching task IDs with compatible task fingerprints/
  );
});

test('eval comparison excludes matching task IDs with incompatible task fingerprints', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const aPath = path.join(tmp, 'oasis-run.json');
  const bPath = path.join(tmp, 'claude-run.json');
  await writeFile(aPath, JSON.stringify({
    label: 'OASIS',
    sourceRevision: 'c'.repeat(40),
    results: [
      { taskId: 'same-task', taskFingerprint: 'a'.repeat(64), status: 'passed', wallTimeMs: 100, costUSD: 0.01 },
      { taskId: 'changed-task', taskFingerprint: 'b'.repeat(64), status: 'passed', wallTimeMs: 150, costUSD: 0.01 },
      { taskId: 'legacy-task', status: 'failed', wallTimeMs: 200, costUSD: 0.01 }
    ]
  }));
  await writeFile(bPath, JSON.stringify({
    label: 'Claude Code',
    results: [
      { taskId: 'same-task', taskFingerprint: 'a'.repeat(64), status: 'passed', wallTimeMs: 90, costUSD: 0.02 },
      { taskId: 'changed-task', taskFingerprint: 'c'.repeat(64), status: 'passed', wallTimeMs: 140, costUSD: 0.02 },
      { taskId: 'legacy-task', status: 'passed', wallTimeMs: 190, costUSD: 0.02 }
    ]
  }));
  const output = { text: '', write(value) { this.text += String(value); } };
  const result = await runEvalCommand(['--compare', aPath, bPath], {
    env: { ...process.env }, output
  });

  assert.equal(result.ok, true, output.text);
  assert.equal(result.comparison.commonTaskCount, 2);
  assert.deepEqual(result.comparison.mismatchedFingerprints, ['changed-task']);
  assert.deepEqual(result.comparison.unverifiedFingerprints, ['legacy-task']);
  assert.equal(result.comparison.tasks.find((row) => row.taskId === 'same-task').fingerprintStatus, 'verified');
  assert.equal(result.comparison.tasks.find((row) => row.taskId === 'legacy-task').fingerprintStatus, 'unverified-legacy');
  assert.equal(result.comparison.metrics.a.taskBalancedPassRate, 0.5);
  assert.equal(result.comparison.metrics.b.taskBalancedPassRate, 1);
  assert.match(output.text, /1\/2 verified; 1 fingerprint-mismatched task\(s\) excluded; 0 metadata-mismatched task\(s\) excluded; 1 legacy\/unfingerprinted task\(s\) compared by ID only/);
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

  await writeFile(bPath, JSON.stringify({ results: [{ taskId: 'task-a', status: 'passed', taskFingerprint: 'not-a-sha256' }] }));
  await assert.rejects(compareEvalReports([aPath, bPath]), /invalid taskFingerprint/);

  const linkPath = path.join(tmp, 'linked.json');
  await symlink(aPath, linkPath);
  await assert.rejects(compareEvalReports([linkPath, bPath]), /regular, non-symlink file/);
});

test('eval comparison requires exactly two report paths and rejects conflicting CLI options', async () => {
  await assert.rejects(
    runEvalCommand(['--out', 'report.json'], { env: { ...process.env } }),
    /--out and --html are only valid with --compare/
  );
  await assert.rejects(
    runEvalCommand(['--compare', 'a.json', 'b.json', '--out', 'same.out', '--html', 'same.out'], { env: { ...process.env } }),
    /JSON and HTML comparison outputs must use different paths/
  );
  await assert.rejects(
    runEvalCommand(['--compare', 'only-one.json'], { env: { ...process.env } }),
    /requires two JSON report paths/
  );
  await assert.rejects(
    runEvalCommand(['--compare', 'a.json', 'b.json', '--task', 'fix-a'], { env: { ...process.env } }),
    /cannot be combined with --task, --trials(?:, --timeout-seconds)? or --claude-code/
  );
});


test('Claude Code JSON parsing preserves reported metrics and leaves absent cost unknown', async () => {
  const { parseClaudeCodeOutput } = await import('../src/eval.mjs');
  const parsed = parseClaudeCodeOutput(JSON.stringify({
    type: 'result',
    result: 'implemented',
    is_error: false,
    total_cost_usd: 0.0123,
    duration_ms: 840,
    num_turns: 4,
    modelUsage: {
      'claude-sonnet-fixture': { inputTokens: 10, outputTokens: 6, costUSD: 0.0123 }
    }
  }));
  assert.equal(parsed.result, 'implemented');
  assert.equal(parsed.model, 'claude-sonnet-fixture');
  assert.equal(parsed.inputTokens, 10);
  assert.equal(parsed.outputTokens, 6);
  assert.equal(parsed.totalTokens, 16);
  assert.equal(parsed.costUSD, 0.0123);
  assert.equal(parsed.numTurns, 4);

  const unpriced = parseClaudeCodeOutput(JSON.stringify({ result: 'ok', usage: { input_tokens: 2, output_tokens: 1 } }));
  assert.equal(unpriced.inputTokens, 2);
  assert.equal(unpriced.outputTokens, 1);
  assert.equal(unpriced.costUSD, null, 'missing cost must not be reported as zero');
  assert.throws(() => parseClaudeCodeOutput('not json'), /valid JSON result/);
});

test('Claude Code eval uses restricted tools, external verification and a comparable report format', async (t) => {
  const tmp = await temporaryDirectory('oasis-claude-eval-test-');
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const tasksDir = path.join(tmp, 'tasks');
  const resultsDir = path.join(tmp, 'results');
  await mkdir(tasksDir);
  const taskDir = await createFixtureTask(tasksDir, 'fixture-task');
  const calls = [];
  const fakeRunner = async (args, runOptions = {}) => {
    calls.push({ args, runOptions });
    if (args.length === 1 && args[0] === '--version') {
      return { exitCode: 0, stdout: '2.1.300\n', stderr: '', output: '', timedOut: false };
    }
    assert.equal(args.includes('--restricted'), true);
    assert.equal(args.includes('--permission-mode'), true);
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(args.includes('--tools'), true);
    assert.equal(args[args.indexOf('--tools') + 1], 'Read,Edit,Write,Glob,Grep,Bash');
    assert.equal(args.includes('Bash(npm test *)'), true);
    assert.equal(args.includes('Bash(npm run check *)'), true);
    assert.equal(args.includes('Bash(git diff *)'), true);
    assert.match(args[args.length - 1], /Change demo\.txt/);
    await writeFile(path.join(runOptions.cwd, 'demo.txt'), 'new\n');
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        type: 'result', result: 'done', is_error: false,
        total_cost_usd: 0.0123, usage: { input_tokens: 10, output_tokens: 3 },
        modelUsage: { 'claude-sonnet-fixture': { inputTokens: 10, outputTokens: 3, costUSD: 0.0123 } },
        num_turns: 2
      }),
      stderr: '', output: '', timedOut: false
    };
  };
  const output = { text: '', write(value) { this.text += String(value); } };
  const result = await runEvalCommand([
    '--claude-code', '--task', 'fixture-task', '--trials', '1', '--model', 'claude-sonnet-fixture'
  ], {
    autoApprove: true,
    env: { ...process.env, GITHUB_SHA: 'b'.repeat(40) },
    tasksDir,
    resultsDir,
    output,
    claudeRunner: fakeRunner
  });

  assert.equal(result.ok, true, output.text);
  assert.equal(result.summary.sourceRevision, 'b'.repeat(40));
  assert.equal(result.summary.provider.protocol, 'claude-code-cli');
  assert.equal(result.summary.provider.model, 'claude-sonnet-fixture');
  assert.equal(result.summary.passed, 1);
  assert.equal(result.results[0].costUSD, 0.0123);
  assert.equal(calls.length, 2, 'one CLI version check and one trial');
  const stored = JSON.parse(await readFile(result.resultsPath, 'utf8'));
  assert.equal(stored.results[0].status, 'passed');
  assert.equal(stored.results[0].taskId, 'fixture-task');
  assert.equal(stored.results[0].passed, true);
  assert.equal((await readFile(path.join(taskDir, 'repo', 'demo.txt'), 'utf8')), 'old\n',
    'the baseline fixture must not be modified');
});

test('Claude Code eval requires explicit approval and rejects incompatible CLI options', async () => {
  await assert.rejects(
    runEvalCommand(['--claude-code'], { autoApprove: false, env: { ...process.env }, tasksDir: '/not-used' }),
    /explicitly run oasis eval --claude-code --yes/
  );
  await assert.rejects(
    runEvalCommand(['--model', 'sonnet'], { autoApprove: true, env: { ...process.env } }),
    /require --claude-code/
  );
  await assert.rejects(
    runEvalCommand(['--claude-code', '--timeout-seconds', '10'], { autoApprove: true, env: { ...process.env } }),
    /timeout-seconds must be an integer/
  );
});

test('eval rejects trial counts with partial, fractional, or exponent syntax', async () => {
  for (const value of ['2junk', '2.5', '1e1', '0', '11', '']) {
    await assert.rejects(
      runEvalCommand(['--trials', value], { autoApprove: false, env: { ...process.env } }),
      /--trials must be an integer from 1 to 10/,
      'should reject trial count ' + JSON.stringify(value)
    );
  }
});


test('eval trial count rejects partial, fractional, scientific and out-of-range values', async () => {
  for (const raw of ['2abc', '2.5', '1e1', '+2', '0', '11', '']) {
    await assert.rejects(
      runEvalCommand(['--trials', raw], { env: { ...process.env }, tasksDir: '/not-used' }),
      /--trials must be an integer from 1 to 10/,
      'reject trial value ' + JSON.stringify(raw)
    );
  }
});

test('OASIS eval applies a whole-turn timeout and aborts the agent session', async (t) => {
  const tmp = await temporaryDirectory('oasis-eval-timeout-test-');
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const configDir = path.join(tmp, 'user-config');
  const resultsDir = path.join(tmp, 'eval-results');
  const tasksDir = path.join(tmp, 'tasks');
  await mkdir(tasksDir);
  await createFixtureTask(tasksDir);
  const env = { ...process.env, OASIS_CONFIG_DIR: configDir };
  await saveConfig({
    protocol: 'openai-compatible',
    baseURL: 'http://127.0.0.1:1/v1',
    model: 'fixture-model',
    apiKey: '',
    maxSteps: 4
  }, { env });

  let observedSignal;
  const output = { text: '', write(value) { this.text += String(value); } };
  const result = await runEvalCommand(['--task', 'fixture-task', '--trials', '1', '--timeout-seconds', '30'], {
    autoApprove: true,
    env,
    tasksDir,
    resultsDir,
    output,
    taskTimeoutMs: 25,
    agentRunner: async (_session, _prompt, options) => {
      observedSignal = options.signal;
      await new Promise((resolve, reject) => {
        const abort = () => {
          const error = new Error('mock agent observed abort');
          error.name = 'AbortError';
          reject(error);
        };
        if (options.signal.aborted) abort();
        else options.signal.addEventListener('abort', abort, { once: true });
      });
      return { finished: true, toolCalls: 0 };
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.timeoutSeconds, 30);
  assert.equal(result.results[0].status, 'failed');
  assert.match(result.results[0].error, /Task exceeded the 1-second task timeout/);
  assert.equal(observedSignal.aborted, true);
});
