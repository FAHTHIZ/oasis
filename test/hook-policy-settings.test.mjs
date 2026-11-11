import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { loadSettings, applyHookPolicy } from '../src/settings.mjs';
import { runHooks, httpHookUrlAllowed } from '../src/hooks.mjs';
import { agentScopedHooks } from '../src/subagent-support.mjs';

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-hook-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const hook = (command) => ({ hooks: [{ type: 'command', command }] });

async function fixture(t, { user = {}, project = null, local = null } = {}) {
  const dir = await tmp(t);
  const root = path.join(dir, 'repo');
  const config = path.join(dir, 'cfg');
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await mkdir(config, { recursive: true });
  await writeFile(path.join(config, 'settings.json'), JSON.stringify(user));
  if (project) await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify(project));
  if (local) await writeFile(path.join(root, '.claude', 'settings.local.json'), JSON.stringify(local));
  // Trust the workspace so project hooks load.
  const env = { HOME: dir, OASIS_CONFIG_DIR: config, OASIS_IGNORE_CLAUDE_SETTINGS: '1', OASIS_TRUST_WORKSPACE: '1' };
  return { root, env };
}

test('disableAllHooks in user or project settings stops their hooks and the status line', async (t) => {
  const { root, env } = await fixture(t, {
    user: { hooks: { PreToolUse: [hook('echo user')] }, statusLine: { type: 'command', command: 'echo status' } },
    project: { disableAllHooks: true, hooks: { Stop: [hook('echo project')] } }
  });
  const settings = await loadSettings(root, { env, skipPlugins: true });
  assert.equal(settings.trusted, true, 'workspace trusted for the test');
  assert.deepEqual(settings.hooks, {});
  assert.equal(settings.statusLine, null);
  assert.equal(settings.hooksDisabled, 'settings');
});

test('a later scope can set disableAllHooks back to false', async (t) => {
  const { root, env } = await fixture(t, {
    user: { disableAllHooks: true, hooks: { PreToolUse: [hook('echo user')] } },
    local: { disableAllHooks: false }
  });
  const settings = await loadSettings(root, { env, skipPlugins: true });
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.equal(settings.hooksDisabled, undefined);
});

test('applyHookPolicy: managed disableAllHooks removes everything; allowManagedHooksOnly keeps managed hooks', () => {
  const base = () => ({
    hooks: { PreToolUse: [{ source: 'managed', matcher: '', hooks: [] }, { source: 'user', matcher: '', hooks: [] }], Stop: [{ source: 'plugin:x', matcher: '', hooks: [] }] },
    statusLine: { type: 'command', command: 'x' }, statusLineSource: 'user'
  });
  const all = applyHookPolicy({ ...base(), hookPolicy: { disableAllManaged: true } });
  assert.deepEqual(all.hooks, {});
  assert.equal(all.hooksDisabled, 'managed');
  const managedOnly = applyHookPolicy({ ...base(), hookPolicy: {}, allowManagedHooksOnly: true });
  assert.deepEqual(Object.keys(managedOnly.hooks), ['PreToolUse']);
  assert.equal(managedOnly.hooks.PreToolUse.length, 1);
  assert.equal(managedOnly.hooks.PreToolUse[0].source, 'managed');
  assert.equal(managedOnly.statusLine, null);
  const keepManagedStatus = applyHookPolicy({ ...base(), statusLineSource: 'managed', hookPolicy: { disableAll: true } });
  assert.deepEqual(keepManagedStatus.statusLine, { type: 'command', command: 'x' });
  const untouched = applyHookPolicy({ ...base(), hookPolicy: {} });
  assert.equal(untouched.hooks.Stop.length, 1);
});

test('agent front-matter hooks are refused while hooks are disabled', () => {
  const agent = { name: 'reviewer', source: 'user', hooks: { PreToolUse: [hook('echo agent')] } };
  const parentHooks = { Stop: [{ source: 'managed', matcher: '', hooks: [] }] };
  assert.ok(agentScopedHooks({ hooks: parentHooks, settings: { trusted: true } }, agent).PreToolUse);
  assert.equal(agentScopedHooks({ hooks: parentHooks, settings: { trusted: true, hooksDisabled: 'managed-only' } }, agent), parentHooks);
});

test('allowedHttpHookUrls patterns: wildcards, case-insensitive hosts, trailing dots', () => {
  assert.equal(httpHookUrlAllowed('https://x.test/a', undefined), true);
  assert.equal(httpHookUrlAllowed('https://x.test/a', []), false);
  const list = ['https://hooks.example.com/*', 'http://localhost:*'];
  assert.equal(httpHookUrlAllowed('https://hooks.example.com/ci/run', list), true);
  assert.equal(httpHookUrlAllowed('https://HOOKS.Example.com./ci', list), true);
  assert.equal(httpHookUrlAllowed('http://localhost:8080/hook', list), true);
  assert.equal(httpHookUrlAllowed('https://hooks.example.com.evil.test/x', list), false);
  assert.equal(httpHookUrlAllowed('http://hooks.example.com/x', list), false);
  assert.equal(httpHookUrlAllowed('not a url', list), false);
});

test('HTTP hooks: blocked URLs never get a request; httpHookAllowedEnvVars limits header variables', async (t) => {
  const seen = [];
  const server = createServer((req, res) => { seen.push({ url: req.url, auth: req.headers.authorization || '', extra: req.headers['x-extra'] || '' }); req.resume(); req.on('end', () => res.end('{}')); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const httpHook = (pathName) => ({ hooks: [{ type: 'http', url: base + pathName, headers: { authorization: 'Bearer $HOOK_TOKEN', 'x-extra': '$OTHER_SECRET' }, allowedEnvVars: ['HOOK_TOKEN', 'OTHER_SECRET'] }] });
  const hooks = { Stop: [httpHook('/allowed'), httpHook('/blocked/x')] };
  const env = { HOOK_TOKEN: 'tok', OTHER_SECRET: 'shh' };
  const result = await runHooks('Stop', { session_id: 's' }, { hooks, root: os.tmpdir(), env, allowedHttpHookUrls: [base + '/allowed'], httpHookAllowedEnvVars: ['HOOK_TOKEN'] });
  assert.deepEqual(seen, [{ url: '/allowed', auth: 'Bearer tok', extra: '' }]);
  assert.ok(result.messages.some((line) => /not in allowedHttpHookUrls/.test(line)), JSON.stringify(result.messages));
});

test('loadSettings merges allowedHttpHookUrls and httpHookAllowedEnvVars across scopes', async (t) => {
  const { root, env } = await fixture(t, {
    user: { allowedHttpHookUrls: ['https://a.test/*'], httpHookAllowedEnvVars: ['A'] },
    project: { allowedHttpHookUrls: ['https://b.test/*'] }
  });
  const settings = await loadSettings(root, { env, skipPlugins: true });
  assert.deepEqual(settings.allowedHttpHookUrls, ['https://a.test/*', 'https://b.test/*']);
  assert.deepEqual(settings.httpHookAllowedEnvVars, ['A']);
});
