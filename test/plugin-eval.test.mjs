import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';
import { normalizeCases, runChecks, parseVerdict, detectTarget, evaluateTarget, formatEvalReport, pluginEvalCli } from '../src/plugin-eval.mjs';

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('cases accept the OASIS and skill-creator layouts', () => {
  const ours = normalizeCases({ cases: [{ id: 'a', prompt: 'p', checks: { contains: 'x', tools_used: ['grep'] }, rubric: 'r' }] });
  assert.deepEqual(ours[0].checks.contains, ['x']);
  assert.deepEqual(ours[0].checks.toolsUsed, ['grep']);
  const theirs = normalizeCases({ skill_name: 's', evals: [{ id: 1, prompt: 'q', expected_output: 'a table', expectations: ['has a header row'] }] });
  assert.equal(theirs[0].id, '1');
  assert.match(theirs[0].rubric, /a table[\s\S]*has a header row/);
  assert.throws(() => normalizeCases({ cases: [{ id: 'x' }] }), /prompt/);
});

test('deterministic checks cover text, files and tools', async (t) => {
  const workspace = await tempDir(t, 'oasis-pe-ws-');
  await writeFile(path.join(workspace, 'NOTES.md'), '## 1.2.0\n- fixed login\n');
  const [testCase] = normalizeCases({ cases: [{ prompt: 'p', checks: { contains: ['Done'], notContains: ['sorry'], regex: ['1\\.2\\.\\d'], files: { 'NOTES.md': 'login', 'gone.txt': false, 'missing.txt': true }, toolsUsed: ['write_file'], toolsNotUsed: ['run_command'] } }] });
  const results = await runChecks(testCase, { text: 'Done: 1.2.0 notes', workspace, tools: ['read_file', 'write_file'] });
  assert.deepEqual(results.map((r) => r.pass), [true, true, true, true, true, false, true, true]);
  await assert.rejects(runChecks(normalizeCases({ cases: [{ prompt: 'p', checks: { files: { '../escape': true } } }] })[0], { text: '', workspace, tools: [] }), /escapes/);
});

test('judge verdicts parse JSON or PASS/FAIL', () => {
  assert.deepEqual(parseVerdict('```json\n{"pass": true, "score": 0.8, "reason": "ok"}\n```'), { pass: true, score: 0.8, reason: 'ok' });
  assert.equal(parseVerdict('FAIL: missing header').pass, false);
  assert.equal(parseVerdict('PASS').score, 1);
});

test('a skill is scored against a no-skill baseline with a real agent loop', async (t) => {
  const base = await tempDir(t, 'oasis-pe-');
  const skill = path.join(base, 'release-notes');
  await mkdir(path.join(skill, 'evals'), { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: release-notes\ndescription: Write release notes into NOTES.md\n---\nAlways write NOTES.md with a version heading.\n');
  await writeFile(path.join(skill, 'evals', 'evals.json'), JSON.stringify({ cases: [{ id: 'notes', prompt: 'write release notes for 1.2.0', files: { 'README.md': '# app\n' }, checks: { contains: ['notes written'], files: { 'NOTES.md': '1\\.2\\.0' }, toolsUsed: ['write_file'] }, rubric: 'NOTES.md has a version heading.' }] }));
  const target = await detectTarget(skill);
  assert.equal(target.kind, 'skill');
  assert.equal(target.name, 'release-notes');
  const { config } = await scriptedModel(t, [(payload) => {
    const messages = payload.messages;
    const system = String(messages[0] && messages[0].content || '');
    const last = messages[messages.length - 1];
    if (/grading an AI coding agent/.test(String(last.content))) return { content: /## 1\.2\.0/.test(String(last.content)) ? '{"pass": true, "score": 1, "reason": "heading present"}' : '{"pass": false, "score": 0, "reason": "no notes"}' };
    if (messages.some((m) => m.role === 'tool')) return { content: 'notes written' };
    if (system.includes('release-notes')) return { tool_calls: [toolCall('w1', 'write_file', { path: 'NOTES.md', content: '## 1.2.0\n- fixes\n' }).tool_calls[0]] };
    return { content: 'I do not know your release process.' };
  }]);
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(base, 'cfg'), HOME: base, OASIS_AUTO_MEMORY: '0', OASIS_PLUGIN_DIRS: '' };
  const report = await evaluateTarget(skill, { env, config });
  assert.equal(report.cases.length, 1);
  assert.equal(report.summary.passRate, 1);
  assert.equal(report.summary.baselinePassRate, 0);
  assert.ok(report.summary.delta > 0.5);
  assert.deepEqual(report.cases[0].with[0].tools, ['write_file']);
  assert.equal(report.cases[0].with[0].verdict.pass, true);
  const text = formatEvalReport(report);
  assert.match(text, /PASS\s+notes/);
  assert.match(text, /the skill helps/);
});

test('eval init writes template cases without a model and refuses to overwrite', async (t) => {
  const base = await tempDir(t, 'oasis-pe-init-');
  const plugin = path.join(base, 'my-plugin');
  await mkdir(path.join(plugin, '.claude-plugin'), { recursive: true });
  await mkdir(path.join(plugin, 'skills', 'lint'), { recursive: true });
  await writeFile(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'my-plugin', description: 'lint helpers' }));
  await writeFile(path.join(plugin, 'skills', 'lint', 'SKILL.md'), '---\nname: lint\ndescription: Fix lint errors\n---\nbody\n');
  let out = '';
  const io = { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} }, config: { configured: false }, env: {} };
  await pluginEvalCli(['init', plugin, '--count', '2'], io);
  const drafted = JSON.parse(await readFile(path.join(plugin, 'evals', 'evals.json'), 'utf8'));
  assert.equal(drafted.cases.length, 2);
  assert.match(drafted.cases[0].prompt, /lint/);
  assert.match(out, /Wrote 2 draft cases/);
  await assert.rejects(pluginEvalCli(['init', plugin], io), /already exists/);
});
