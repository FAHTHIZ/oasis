import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { saveConfig } from '../src/config.mjs';
import { runEvalCommand, validateEvaluationSuite } from '../src/eval.mjs';

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
    } else {
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Updated and verified.' } }],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 }
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
  assert.equal(requests, 2);
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

