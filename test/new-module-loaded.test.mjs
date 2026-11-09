import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createSession, closeSession, runAgentTurn } from '../src/agent.mjs';
import { newModuleCandidate, unloadedNewModules, markLoadedModules, verificationIssues } from '../src/turn-guards.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

test('which new files count as importable JavaScript modules', () => {
  assert.equal(newModuleCandidate('src/lib.mjs', 'export function f() {}'), true);
  assert.equal(newModuleCandidate('src/lib.cjs', 'module.exports = { f }'), true);
  assert.equal(newModuleCandidate('src/run.mjs', 'console.log(1)'), false, 'scripts without exports are not imported (that would run them)');
  assert.equal(newModuleCandidate('test/lib.test.mjs', 'export const x = 1'), false);
  assert.equal(newModuleCandidate('src/App.js', 'export default function App() { return <Main />; }'), false, 'JSX');
  assert.equal(newModuleCandidate('src/ui.js', "import './ui.css';\nexport const x = 1;"), false, 'bundler imports');
  assert.equal(newModuleCandidate('src/dom.js', 'export const el = document.body;'), false, 'browser code');
  assert.equal(newModuleCandidate('src/lib.ts', 'export const x = 1'), false);
});

test('a passing check that never loaded a new module does not satisfy the gate', () => {
  const state = { changedPaths: new Set(['src/lib.mjs']), createdPaths: new Set(['src/lib.mjs']), diffReviewedPaths: new Set(), lspVerificationByPath: new Map(), moduleCandidates: new Set(['src/lib.mjs']), lastVerificationExitCode: 0 };
  assert.deepEqual(unloadedNewModules(state), ['src/lib.mjs']);
  assert.match(verificationIssues(state).join(' '), /new module src\/lib\.mjs was not loaded or run/);
  markLoadedModules(state, 'node src/lib.mjs', 1);
  assert.deepEqual(unloadedNewModules(state), ['src/lib.mjs'], 'a failed run does not count');
  markLoadedModules(state, 'node --input-type=module -e ... src/lib.mjs', 0);
  assert.deepEqual(verificationIssues(state), []);
  const withTest = { ...state, loadedPaths: new Set(), changedPaths: new Set(['src/lib.mjs', 'test/lib.test.mjs']) };
  assert.deepEqual(unloadedNewModules(withTest), [], 'a changed test file is trusted to import it');
});

// Seen in a live eval (glob-match, gpt-oss-20b): npm test passed without
// loading the new src/lib.mjs, which threw "require is not defined" on import.
test('the harness imports a new module the passing check never loaded, and the model sees it fail', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-newmod-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-newmod-cfg-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(configDir, { recursive: true, force: true }); });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'p', type: 'module', scripts: { test: 'node -e "process.exit(0)"' } }));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base'], { cwd: root });
  } catch { t.skip('git unavailable'); return; }
  const { config, requests } = await scriptedModel(t, [
    toolCall('w1', 'write_file', { path: 'src/lib.mjs', content: 'export function f() { return 1; }\nif (require.main === module) console.log(f());\n' }),
    toolCall('r1', 'run_command', { command: 'npm', args: ['test'] }),
    { content: 'Created src/lib.mjs; npm test passes.' },
    toolCall('e1', 'edit_file', { path: 'src/lib.mjs', old_string: 'if (require.main === module) console.log(f());\n', new_string: '' }),
    toolCall('r2', 'run_command', { command: 'npm', args: ['test'] }),
    toolCall('r3', 'run_command', { command: 'node', args: ['src/lib.mjs'] }),
    { content: 'Removed the CommonJS check; the module loads and npm test passes.' }
  ]);
  const env = { ...process.env, OASIS_CONFIG_DIR: configDir, OASIS_SANDBOX: '0', OASIS_ASSISTED_VERIFICATION: '1' };
  const session = await createSession({ root, env, config });
  t.after(() => closeSession(session));
  const result = await runAgentTurn(session, 'Create src/lib.mjs exporting f().', { env, autoApprove: true });
  const toolResults = requests.flatMap((request) => request.messages).filter((message) => message.role === 'tool').map((message) => String(message.content));
  assert.ok(toolResults.some((text) => /require is not defined/.test(text)), 'the import check ran and its failure reached the model');
  assert.equal(result.verificationIncomplete, false, JSON.stringify(result.verificationIssues));
});

test('modules that would start a server or read argv are not loaded by the harness', () => {
  assert.equal(newModuleCandidate('src/server.mjs', "export const s = 1;\ncreateServer().listen(3000);"), false);
  assert.equal(newModuleCandidate('src/cli.mjs', "export const s = 1;\nmain(process.argv);"), false);
});
