import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('repository identity, package keywords and GitHub topics are aligned', async () => {
  const [metadata, packageText] = await Promise.all([
    read('../.github/scripts/apply-repository-metadata.mjs'),
    read('../package.json')
  ]);
  const pkg = JSON.parse(packageText);
  const topicMatch = metadata.match(/const topics = (\\[[\\s\\S]*?\\]);/);
  assert.ok(topicMatch, 'repository topic list must be declared in the metadata workflow');
  const topics = JSON.parse(topicMatch[1]);
  assert.equal(topics.length, 20, 'GitHub topics should use the supported limit without duplicates');
  assert.equal(new Set(topics).size, topics.length);
  for (const topic of ['ai-coding-agent', 'agent-runtime', 'coding-agent', 'cli', 'mcp', 'ollama', 'open-source', 'vscode']) {
    assert.ok(topics.includes(topic), 'Missing repository topic: ' + topic);
  }
  assert.ok(!topics.includes('claude-code-alternative'));
  assert.ok(metadata.includes('model-agnostic coding-agent runtime'));
  assert.ok(metadata.includes("new URL('app/', deploymentUrl).toString()"), 'The repository homepage should point directly to the browser app.');
  assert.ok(pkg.keywords.length <= 20);
  assert.equal(new Set(pkg.keywords).size, pkg.keywords.length);
  assert.ok(pkg.keywords.includes('ai-coding-agent'));
  assert.ok(pkg.keywords.includes('agent-runtime'));
  assert.ok(pkg.description.includes('model-agnostic coding-agent runtime'));
  assert.equal(pkg.homepage, 'https://github.com/FAHTHIZ/oasis#readme');
});

test('issue-template contact links point to live support, releases and private security reporting', async () => {
  const config = await read('../.github/ISSUE_TEMPLATE/config.yml');
  assert.ok(config.includes('https://github.com/FAHTHIZ/oasis/security/advisories/new'));
  assert.ok(config.includes('https://github.com/FAHTHIZ/oasis/discussions'));
  assert.ok(config.includes('https://github.com/FAHTHIZ/oasis/releases/latest'));
  assert.ok(config.includes('https://fahthiz.github.io/oasis/app/'));
  assert.ok(!config.includes('docs/USER_GUIDE.md'));
});

test('mobile and contributor policies exist outside the installable npm package', async () => {
  const [pkgText, mobile, contributing, security, support, changelog] = await Promise.all([
    read('../package.json'), read('../MOBILE.md'), read('../CONTRIBUTING.md'),
    read('../SECURITY.md'), read('../SUPPORT.md'), read('../CHANGELOG.md')
  ]);
  const pkg = JSON.parse(pkgText);
  assert.ok(mobile.includes('oasis web --host 0.0.0.0'));
  assert.ok(mobile.includes('oasis app --lan'));
  assert.ok(mobile.includes('There is no native Android APK'));
  assert.ok(contributing.includes('npm run check'));
  assert.ok(security.includes('private vulnerability reporting'));
  assert.ok(support.includes('oasis doctor'));
  assert.ok(changelog.includes('[1.1.0]'));
  assert.ok(!pkg.files.includes('MOBILE.md'));
  assert.ok(!pkg.files.includes('CONTRIBUTING.md'));
  assert.ok(!pkg.files.includes('SECURITY.md'));
});
