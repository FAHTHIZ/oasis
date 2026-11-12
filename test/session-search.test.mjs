import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveSession } from '../src/sessions.mjs';
import { searchSessions, formatSessionSearch, runSessionSearchTool, tokenize, SESSION_SEARCH_TOOL_DEFINITION } from '../src/session-search.mjs';
import { executeTool } from '../src/tools.mjs';

const chat = (root, user, assistant) => ({ root, config: { model: 'm' }, messages: [{ role: 'system', content: 's' }, { role: 'user', content: user }, { role: 'assistant', content: assistant }] });

test('session search ranks matching conversations, excludes the current one and redacts secrets', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-recall-'));
  const root = path.join(base, 'proj'); await mkdir(root);
  const env = { OASIS_CONFIG_DIR: path.join(base, 'config') };
  try {
    const a = await saveSession(chat(root, 'Fix the flaky websocket reconnect test', 'The reconnect backoff was missing jitter; added jitter and a fake clock. Key sk-ant-api03-' + 'x'.repeat(40)), { env });
    const b = await saveSession(chat(root, 'Add dark mode', 'Added a theme toggle in settings.'), { env });
    const found = await searchSessions(root, 'websocket reconnect jitter', { env });
    assert.equal(found.searched, 2);
    assert.equal(found.results[0].sessionId, a.id);
    assert.ok(!found.results.some((item) => item.sessionId === b.id));
    assert.ok(!JSON.stringify(found).includes('x'.repeat(40)), 'secrets are redacted');
    const excluded = await searchSessions(root, 'websocket', { env, excludeId: a.id });
    assert.equal(excluded.results.length, 0);
    const userOnly = await searchSessions(root, 'jitter', { env, role: 'user' });
    assert.equal(userOnly.results.length, 0);
    assert.match(formatSessionSearch(found, 'websocket'), /oasis --resume/);
    assert.match(await runSessionSearchTool({ query: 'dark mode' }, { root, env }), new RegExp(b.id));
    assert.match(await executeTool('session_search', { query: 'theme toggle' }, { root, env }), new RegExp(b.id));
    await assert.rejects(() => searchSessions(root, 'the and of', { env }), /keyword/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('session search scope all covers other workspaces; workspace scope does not', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-recall-all-'));
  const one = path.join(base, 'one'); const two = path.join(base, 'two');
  await mkdir(one); await mkdir(two);
  const env = { OASIS_CONFIG_DIR: path.join(base, 'config') };
  try {
    await saveSession(chat(two, 'Migrate postgres schema', 'Wrote the migration.'), { env });
    assert.equal((await searchSessions(one, 'postgres', { env })).results.length, 0);
    const all = await searchSessions(one, 'postgres', { env, scope: 'all' });
    assert.equal(all.results.length, 1);
    assert.equal(path.resolve(all.results[0].workspace), path.resolve(two));
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('session search tool schema is strict and tokenizer drops stop words', () => {
  assert.equal(SESSION_SEARCH_TOOL_DEFINITION.function.parameters.additionalProperties, false);
  assert.deepEqual(tokenize('The Websocket and the API'), ['websocket', 'api']);
});

test('session search matches word prefixes, so a short query finds longer words', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-recall-prefix-'));
  const root = path.join(base, 'proj'); await mkdir(root);
  const env = { OASIS_CONFIG_DIR: path.join(base, 'config') };
  try {
    const a = await saveSession(chat(root, 'Set up the authentication middleware', 'Added configuration for the OAuth provider.'), { env });
    await saveSession(chat(root, 'Add dark mode', 'Added a theme toggle in settings.'), { env });
    const found = await searchSessions(root, 'auth config', { env });
    assert.equal(found.results[0] && found.results[0].sessionId, a.id);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('session search keeps an FTS5 index that only re-reads changed session files', async () => {
  const { writeFile, readFile, stat, unlink, readdir } = await import('node:fs/promises');
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-recall-index-'));
  const root = path.join(base, 'proj'); await mkdir(root);
  const env = { OASIS_CONFIG_DIR: path.join(base, 'config') };
  try {
    const a = await saveSession(chat(root, 'Fix the flaky websocket reconnect test', 'Added jitter.'), { env });
    const b = await saveSession(chat(root, 'Add dark mode', 'Added a theme toggle.'), { env });
    const first = await searchSessions(root, 'websocket', { env });
    assert.equal(first.reindexed, 2);
    const indexFile = path.join(env.OASIS_CONFIG_DIR, 'sessions', 'search-index.sqlite');
    if (process.platform !== 'win32') assert.equal((await stat(indexFile)).mode & 0o777, 0o600);
    const again = await searchSessions(root, 'websocket', { env });
    assert.equal(again.reindexed, 0, 'unchanged files are not re-read');
    assert.equal(again.results[0].sessionId, a.id);

    // Edits, deletions and new files are picked up.
    const dir = path.dirname((await readdir(path.dirname(indexFile), { recursive: true, withFileTypes: true })).filter((e) => e.isFile() && e.name === b.id + '.json').map((e) => path.join(e.parentPath, e.name))[0]);
    const bFile = path.join(dir, b.id + '.json');
    const data = JSON.parse(await readFile(bFile, 'utf8'));
    data.messages.push({ role: 'user', content: 'Now the websocket reconnect shows in dark mode too' });
    await writeFile(bFile, JSON.stringify(data));
    const edited = await searchSessions(root, 'websocket', { env });
    assert.equal(edited.reindexed, 1);
    assert.ok(edited.results.some((item) => item.sessionId === b.id));
    await unlink(path.join(dir, a.id + '.json'));
    const c = await saveSession(chat(root, 'Kubernetes liveness probe', 'Raised initialDelaySeconds.'), { env });
    const after = await searchSessions(root, 'websocket', { env });
    assert.equal(after.reindexed, 2, 'one deletion and one new file');
    assert.ok(!after.results.some((item) => item.sessionId === a.id));
    assert.equal((await searchSessions(root, 'liveness', { env })).results[0].sessionId, c.id);

    // A corrupt cache is rebuilt from the session files.
    await writeFile(indexFile, 'not a database'.repeat(100));
    const rebuilt = await searchSessions(root, 'liveness', { env });
    assert.equal(rebuilt.reindexed, 2);
    assert.equal(rebuilt.results[0].sessionId, c.id);
    assert.equal((await searchSessions(root, 'liveness', { env })).reindexed, 0, 'the rebuilt cache is persisted');
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('session search reads legacy session files as-is and loads node:sqlite without warnings', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { getSessionDirectory } = await import('../src/sessions.mjs');
  const { execFileSync } = await import('node:child_process');
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-recall-legacy-'));
  const root = path.join(base, 'proj'); await mkdir(root);
  const env = { OASIS_CONFIG_DIR: path.join(base, 'config') };
  try {
    const dir = getSessionDirectory(root, env); await mkdir(dir, { recursive: true });
    // A minimal file as older releases wrote it: no name, config or usage fields.
    const id = '0123456789abcdef0123456789abcdef';
    await writeFile(path.join(dir, id + '.json'), JSON.stringify({ schemaVersion: 1, id, workspaceRoot: root, updatedAt: '2025-01-01T00:00:00.000Z', messages: [{ role: 'user', content: 'Translate onboarding to German' }] }));
    await writeFile(path.join(dir, 'fedcba9876543210fedcba9876543210.json'), '{ not json');
    const found = await searchSessions(root, 'german', { env });
    assert.equal(found.results[0].sessionId, id);
    assert.equal(found.searched, 2, 'the unreadable file is skipped, not fatal');
    assert.equal(found.results[0].title, 'Translate onboarding to German');
    const script = `import { searchSessions } from ${JSON.stringify(new URL('../src/session-search.mjs', import.meta.url).href)}; await searchSessions(${JSON.stringify(root)}, 'german', { env: ${JSON.stringify(env)} });`;
    const stderr = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(stderr, '');
  } finally { await rm(base, { recursive: true, force: true }); }
});
