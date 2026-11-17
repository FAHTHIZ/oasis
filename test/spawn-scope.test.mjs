import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeployStep, parentIsReadOnly, spawnScope } from '../src/spawn-scope.mjs';

test('deploy steps are commands or instructions, not research about deploys', () => {
  for (const text of ['Deploy the app to production.', 'Fix the bug. Then publish it to npm.', 'run npm publish --access public', 'git push origin main', '- release v2.1.0', 'kubectl apply -f k8s/']) assert.equal(isDeployStep(text), true, text);
  for (const text of ['Find out how the deploy script works.', 'Explain our release process.', 'Read the publishing docs and summarize them.', 'List files under deploy/']) assert.equal(isDeployStep(text), false, text);
});

// Every combination of parent mode, child definition and task.
test('property: a read-only parent never starts a child that can write or deploy', () => {
  const parents = [
    { name: 'default', parent: {}, options: {} },
    { name: 'plan option', parent: {}, options: { planOnly: true } },
    { name: 'plan mode', parent: { permissionMode: 'plan' }, options: {} },
    { name: 'read-only subagent', parent: { scopeReadOnly: true }, options: {} }
  ];
  const prompts = ['Read src and summarize.', 'Deploy the app.', 'Run npm publish.', 'Find how deploys work.'];
  for (const { name, parent, options } of parents) {
    const readOnlyParent = parentIsReadOnly(parent, options);
    assert.equal(readOnlyParent, name !== 'default', name);
    for (const childReadOnly of [false, true]) {
      for (const prompt of prompts) {
        const scope = spawnScope({ parent, options, prompt, childReadOnly });
        if (!readOnlyParent) {
          assert.equal(scope.error, '', name + ': ' + prompt);
          assert.equal(scope.readOnly, childReadOnly);
          continue;
        }
        assert.equal(scope.readOnly, true, name + ' made a writable child');
        assert.equal(Boolean(scope.error), isDeployStep(prompt), name + ': ' + prompt);
      }
    }
  }
});

test('runSubagent refuses a deploy step from a plan-mode parent and forces read-only children', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const { createSession } = await import('../src/agent.mjs');
  const { runSubagent } = await import('../src/agent-subagents.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = await createSession({ root, env: { ...process.env, OASIS_NEURON_LEDGER: '0' }, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'fixture', apiKey: '', maxSteps: 2 } });
  session.scopeReadOnly = true;
  await assert.rejects(runSubagent(session, { description: 'ship', prompt: 'Deploy the app to production.', subagent_type: 'general-purpose' }, {}, { env: process.env }), /read-only agent cannot start a subagent for a deploy/);
});
