import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createCompleter, suggestFilesWithCommand } from '../src/completion.mjs';
import { loadSettings } from '../src/settings.mjs';
import { startOasisWebServer } from '../src/web.mjs';

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-filesuggest-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const node = (code) => JSON.stringify(process.execPath) + ' -e ' + JSON.stringify(code);
// Echoes 20 paths built from the query plus the project dir it was given.
const indexer = node('let s="";process.stdin.on("data",(c)=>s+=c);process.stdin.on("end",()=>{const q=JSON.parse(s).query;const out=[];for(let i=0;i<20;i++)out.push(q+"/file"+i+".ts");out.push(process.env.CLAUDE_PROJECT_DIR);process.stdout.write(out.join("\\n"))})');

test('fileSuggestion receives {"query"} on stdin and at most 15 paths are offered', async (t) => {
  const root = await tmp(t);
  const files = await suggestFilesWithCommand({ type: 'command', command: indexer }, 'src/comp', { root });
  assert.equal(files.length, 15);
  assert.equal(files[0], 'src/comp/file0.ts');
  const complete = createCompleter({ root, fileSuggestion: () => ({ type: 'command', command: indexer }) });
  const result = await complete('look at @src/comp', 17);
  assert.equal(result.candidates.length, 15);
  assert.equal(result.candidates[3].value, '@src/comp/file3.ts');
});

test('a failing fileSuggestion command falls back to the built-in suggestion', async (t) => {
  const root = await tmp(t);
  await writeFile(path.join(root, 'notes.md'), 'x');
  const complete = createCompleter({ root, fileSuggestion: () => ({ type: 'command', command: node('process.exit(3)') }) });
  const result = await complete('@not', 4);
  assert.deepEqual(result.candidates.map((item) => item.value), ['@notes.md']);
  assert.equal(await suggestFilesWithCommand(null, 'x', { root }), null);
});

test('fileSuggestion follows the status line gates: trusted files only, managed-only under allowManagedHooksOnly', async (t) => {
  const home = await tmp(t);
  const root = path.join(home, 'repo');
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify({ fileSuggestion: { type: 'command', command: 'project-index' } }));
  const base = { HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'), OASIS_MANAGED_SETTINGS: '' };
  assert.equal((await loadSettings(root, { env: base })).fileSuggestion, null, 'untrusted project');
  const trusted = await loadSettings(root, { env: { ...base, OASIS_TRUST_WORKSPACE: '1' } });
  assert.deepEqual(trusted.fileSuggestion, { type: 'command', command: 'project-index' });
  const managed = path.join(home, 'managed.json');
  await writeFile(managed, JSON.stringify({ allowManagedHooksOnly: true }));
  const narrowed = await loadSettings(root, { env: { ...base, OASIS_TRUST_WORKSPACE: '1', OASIS_MANAGED_SETTINGS: managed } });
  assert.equal(narrowed.fileSuggestion, null);
  await writeFile(managed, JSON.stringify({ allowManagedHooksOnly: true, fileSuggestion: { type: 'command', command: 'managed-index' } }));
  const kept = await loadSettings(root, { env: { ...base, OASIS_TRUST_WORKSPACE: '1', OASIS_MANAGED_SETTINGS: managed } });
  assert.deepEqual(kept.fileSuggestion, { type: 'command', command: 'managed-index' });
});

test('the web composer gets the same fileSuggestion paths from /api/file-suggestions, behind the token', async (t) => {
  const home = await tmp(t);
  const root = path.join(home, 'repo');
  await mkdir(root, { recursive: true });
  const config = path.join(home, 'cfg');
  await mkdir(config, { recursive: true });
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: config, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), OASIS_MANAGED_SETTINGS: '', OASIS_IGNORE_CLAUDE_SETTINGS: '1' };
  const token = 'test-runtime-token-0123456789';
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token });
  t.after(() => app.close());
  const url = 'http://127.0.0.1:' + app.port + '/api/file-suggestions?q=' + encodeURIComponent('src/comp');
  const get = async () => (await fetch(url, { headers: { authorization: 'Bearer ' + token } })).json();
  assert.equal((await fetch(url)).status, 401);
  assert.deepEqual(await get(), { paths: null }, 'no setting: the app uses its own file list');
  await writeFile(path.join(config, 'settings.json'), JSON.stringify({ fileSuggestion: { type: 'command', command: indexer } }));
  const body = await get();
  assert.equal(body.paths.length, 15);
  assert.equal(body.paths[0], 'src/comp/file0.ts');
});
