import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { keywordMatches, keywordRulesFor, loadMemory, nestedMemoryFor, projectRules } from '../src/memory.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';

async function workspace(t, files, homeFiles = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-openhands-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const home = path.join(base, 'home');
  for (const [dir, list] of [[root, files], [home, homeFiles]]) {
    await mkdir(dir, { recursive: true });
    for (const [rel, text] of Object.entries(list)) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), text);
    }
  }
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: path.join(base, 'claude'), OASIS_CONFIG_DIR: path.join(base, 'cfg'), OASIS_OTHER_AGENT_RULES: '' };
  return { root, env, home };
}

const files = {
  '.openhands/microagents/repo.md': 'OH-REPO always run make test.',
  '.openhands/microagents/git.md': '---\nname: git\ntype: knowledge\ntriggers:\n- git\n- commit\n---\nOH-GIT sign every commit.',
  '.openhands/microagents/release.md': '---\nname: release\ninputs:\n  - name: VERSION\n    description: version to tag\n---\nOH-TASK tag the release.',
  '.openhands/skills/frontend.md': '---\npaths: web/**/*.tsx\ntriggers:\n- react\n---\nOH-PATHS use hooks.',
  '.openhands/skills/README.md': 'OH-README not a skill.',
  '.openhands/skills/pdf/SKILL.md': '---\nname: pdf\ndescription: PDF tools\n---\nOH-SKILLMD body.'
};

test('OpenHands keyword matching is whole-token and case-insensitive', () => {
  assert.ok(keywordMatches('git', 'Please use Git here'));
  assert.ok(!keywordMatches('git', 'open github issues'));
  assert.ok(!keywordMatches('issue', 'tissue sample'));
  assert.ok(keywordMatches('/linear', 'run /linear now'));
  assert.ok(keywordMatches('c++', 'port it to C++.'));
});

test('.openhands microagents: no triggers is always-on, triggers are keyword rules, paths win', async (t) => {
  const { root, env, home } = await workspace(t, files, { '.openhands/skills/docker.md': '---\ntriggers:\n- docker\n---\nOH-USER-DOCKER body.' });
  const memory = await loadMemory(root, { env, home });
  assert.match(memory, /OH-REPO/);
  for (const marker of ['OH-GIT', 'OH-TASK', 'OH-PATHS', 'OH-README', 'OH-SKILLMD', 'OH-USER-DOCKER']) assert.ok(!memory.includes(marker), marker);
  const rules = await projectRules(root, { env, home });
  const byName = Object.fromEntries(rules.filter((rule) => rule.label.includes('openhands')).map((rule) => [rule.label, rule]));
  assert.equal(byName['.openhands/microagents/git.md'].mode, 'keyword');
  assert.deepEqual(byName['.openhands/microagents/git.md'].triggers, ['git', 'commit']);
  assert.deepEqual(byName['.openhands/microagents/release.md'].triggers, ['/release'], 'task microagents trigger on /name');
  assert.equal(byName['.openhands/skills/frontend.md'].mode, 'scoped');
  assert.equal(byName['~/.openhands/skills/docker.md'].scope, 'user');
  assert.ok(!Object.keys(byName).some((label) => /README|SKILL\.md/.test(label)));
  const nested = await nestedMemoryFor(root, path.join(root, 'web', 'app', 'page.tsx'), new Set(), { env, home });
  assert.ok(nested.some((item) => item.text.includes('OH-PATHS')));

  const recalled = await keywordRulesFor(root, 'Commit this, then build the Docker image', { env, home });
  assert.deepEqual(recalled.labels.sort(), ['.openhands/microagents/git.md', '~/.openhands/skills/docker.md']);
  assert.match(recalled.text, /<EXTRA_INFO>\nThe following information has been included based on a keyword match for "commit"\.\nIt may or may not be relevant to the user's request\.\nSkill location: \.openhands\/microagents\/git\.md\n\nOH-GIT sign every commit\.\n<\/EXTRA_INFO>/);
  assert.equal((await keywordRulesFor(root, 'look at github stars', { env, home })).text, '');
  assert.equal((await keywordRulesFor(root, 'commit', { env: { ...env, OASIS_OTHER_AGENT_RULES: '0' }, home })).text, '');
});

test('a triggered microagent is added to the user message once per conversation', async (t) => {
  const { root, env } = await workspace(t, files);
  const payloads = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    payloads.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 2 };
  const session = await createSession({ root, config, env });
  await runAgentTurn(session, 'please commit the fix', { env, autoApprove: true });
  const firstUser = payloads[0].messages.filter((m) => m.role === 'user').at(-1);
  assert.match(String(firstUser.content), /keyword match for "commit"[\s\S]*OH-GIT/);
  await runAgentTurn(session, 'commit again with git', { env, autoApprove: true });
  const all = JSON.stringify(payloads.at(-1).messages);
  assert.equal(all.split('OH-GIT').length - 1, 1, 'not repeated in the same conversation');
});

test('a task microagent lists its inputs and asks the user for missing ones', async (t) => {
  const { root, env, home } = await workspace(t, { ...files, '.openhands/microagents/deploy.md': '---\nname: deploy\ntriggers:\n- /deploy\n---\nDeploy ${SERVICE} to ${REGION}.' });
  const rules = await projectRules(root, { env, home });
  const release = rules.find((rule) => rule.label === '.openhands/microagents/release.md');
  assert.deepEqual(release.inputs, [{ name: 'VERSION', description: 'version to tag' }]);
  const recalled = await keywordRulesFor(root, 'please /release', { env, home });
  assert.match(recalled.text, /OH-TASK tag the release\.\n\nInputs this task needs:\n- VERSION: version to tag\n\nIf the user didn't provide any of these variables, ask the user to provide them first/);
  const deploy = await keywordRulesFor(root, '/deploy now', { env, home });
  assert.match(deploy.text, /Inputs this task needs:\n- SERVICE\n- REGION\n/);
  const plain = await keywordRulesFor(root, 'commit it', { env, home });
  assert.ok(!plain.text.includes('Inputs this task needs'));
});

test('SKILL.md files with triggers are added on a keyword match, once per conversation', async (t) => {
  const { root, env, home } = await workspace(t, { ...files, '.agents/skills/k8s/SKILL.md': '---\nname: k8s\ndescription: Kubernetes help\ntriggers:\n- kubectl\n- helm\n---\nOH-K8S use namespaces.' });
  const recalled = await keywordRulesFor(root, 'run Helm upgrade', { env, home });
  assert.deepEqual(recalled.labels, [path.join(root, '.agents', 'skills', 'k8s', 'SKILL.md')]);
  assert.match(recalled.text, /keyword match for "helm"[\s\S]*Skill location: .*\.agents[\\/]skills[\\/]k8s[\\/]SKILL\.md\n\nOH-K8S use namespaces\./);
  assert.ok(!recalled.text.includes('triggers:'));
  assert.equal((await keywordRulesFor(root, 'run helm', { env, home, alreadyLoaded: (label) => label === recalled.labels[0] })).text, '');
  assert.equal((await keywordRulesFor(root, 'the pdf tool', { env, home })).text, '', 'skills without triggers are not injected');
});
