import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MemoryStore, Workspace, cleanPath, lineDiff } from '../app/core/workspace.mjs';
import { executeTool, globToRegExp, needsApproval, TOOL_DEFINITIONS } from '../app/core/tools.mjs';
import { InlineSandbox } from '../app/core/sandbox.mjs';
import { Agent, buildSystemPrompt, textOf } from '../app/core/agent.mjs';
import { SkillLibrary, parseSkill } from '../app/core/skills.mjs';
import { createZip, readZip } from '../app/core/zip.mjs';
import { GitHub, parseRepo } from '../app/core/github.mjs';
import { chat, toAnthropic, PRESETS } from '../app/core/providers.mjs';

async function project(files = []) {
  return Workspace.create(new MemoryStore(), { name: 'demo', files });
}

test('workspace paths cannot escape the project', () => {
  assert.equal(cleanPath('./src//a.js'), 'src/a.js');
  assert.equal(cleanPath('/README.md'), 'README.md');
  assert.throws(() => cleanPath('../etc/passwd'), /inside the project/);
  assert.throws(() => cleanPath('a/../../b'), /inside the project/);
});

test('workspace tracks added, modified and deleted files', async () => {
  const ws = await project([{ path: 'a.txt', content: 'one' }, { path: 'b.txt', content: 'two' }]);
  await ws.write('a.txt', 'ONE');
  await ws.write('c.txt', 'new');
  await ws.remove('b.txt');
  assert.deepEqual(await ws.changes(), [
    { path: 'a.txt', status: 'modified' },
    { path: 'b.txt', status: 'deleted' },
    { path: 'c.txt', status: 'added' }
  ]);
  assert.deepEqual(await ws.paths(), ['a.txt', 'c.txt']);
  await ws.revert('a.txt');
  assert.equal(await ws.read('a.txt'), 'one');
  await ws.markClean();
  assert.deepEqual(await ws.changes(), []);
});

test('line diff marks additions and deletions', () => {
  const diff = lineDiff('a\nb\nc', 'a\nB\nc');
  assert.ok(diff.some((d) => d.type === 'del' && d.text === 'b'));
  assert.ok(diff.some((d) => d.type === 'add' && d.text === 'B'));
  // Two far-apart edits in a long file: only the changed span plus context.
  const long = Array.from({ length: 3000 }, (_, i) => 'line ' + i).join('\n');
  const changed = long.replace('line 10\n', 'LINE 10\n').replace('line 2990\n', 'LINE 2990\n');
  const ops = lineDiff(long, changed);
  assert.equal(ops.filter((d) => d.type === 'del').length, 2);
  assert.equal(ops[0].line, 8);
});

test('edit_file returns a valid unified diff that applies to the old file', async () => {
  const { applyPatch } = await import('diff');
  const before = Array.from({ length: 40 }, (_, i) => 'row ' + i).join('\n') + '\n';
  const ws = await project([{ path: 'big.txt', content: before }]);
  const out = await executeTool('edit_file', { path: 'big.txt', old_string: 'row 20\n', new_string: 'row twenty\n' }, { workspace: ws });
  const patch = out.slice(out.indexOf('--- a/'));
  assert.match(patch, /^@@ -18,7 \+18,7 @@$/m);
  assert.equal(applyPatch(before, patch), await ws.read('big.txt'));
});

test('glob patterns match like a shell', () => {
  assert.ok(globToRegExp('src/**/*.js').test('src/a/b/c.js'));
  assert.ok(globToRegExp('src/**/*.js').test('src/c.js'));
  assert.ok(globToRegExp('*.md').test('docs/x.md'));
  assert.ok(!globToRegExp('src/*.js').test('src/a/b.js'));
  assert.ok(globToRegExp('*.{ts,tsx}').test('a/b.tsx'));
});

test('file tools read, edit with relaxed matching, grep and glob', async () => {
  const ws = await project([{ path: 'src/math.js', content: 'function add(a, b) {\n    return a - b;\n}\nmodule.exports = { add };\n' }]);
  const ctx = { workspace: ws };
  const read = await executeTool('read_file', { path: 'src/math.js' }, ctx);
  assert.match(read, /^ {4}1 {2}function add/);
  // Indentation differs from the file: relaxed matching still applies it.
  const edited = await executeTool('edit_file', { path: 'src/math.js', old_string: 'return a - b;', new_string: 'return a + b;' }, ctx);
  assert.match(edited, /Edited src\/math.js/);
  assert.match(await ws.read('src/math.js'), / {4}return a \+ b;/);
  await assert.rejects(executeTool('edit_file', { path: 'src/math.js', old_string: 'nothing like this', new_string: 'x' }, ctx), /not found/);
  assert.match(await executeTool('grep', { pattern: 'a + b' }, ctx), /src\/math.js:2:/);
  assert.equal(await executeTool('glob_files', { pattern: '**/*.js' }, ctx), 'src/math.js');
  assert.match(await executeTool('project_changes', {}, ctx), /modified src\/math.js/);
});

test('edit_file refuses ambiguous matches unless replace_all', async () => {
  const ws = await project([{ path: 'x.txt', content: 'a\na\n' }]);
  await assert.rejects(executeTool('edit_file', { path: 'x.txt', old_string: 'a', new_string: 'b' }, { workspace: ws }), /matches 2 places/);
  await executeTool('edit_file', { path: 'x.txt', old_string: 'a', new_string: 'b', replace_all: true }, { workspace: ws });
  assert.equal(await ws.read('x.txt'), 'b\nb\n');
});

test('approval modes', () => {
  assert.equal(needsApproval('read_file', 'ask'), false);
  assert.equal(needsApproval('edit_file', 'ask'), true);
  assert.equal(needsApproval('edit_file', 'edits'), false);
  assert.equal(needsApproval('delete_file', 'edits'), true);
  assert.equal(needsApproval('fetch_url', 'auto'), false);
  assert.equal(needsApproval('github_push', 'auto'), true);
  assert.ok(TOOL_DEFINITIONS.every((tool) => tool.function.parameters.type === 'object'));
});

test('sandbox runs project modules, ESM, assert and tests', async () => {
  const ws = await project([
    { path: 'lib/sum.js', content: 'exports.sum = (a, b) => a + b;' },
    { path: 'lib/esm.mjs', content: 'export function twice(x) { return x * 2; }\nexport default 7;' },
    { path: 'data.json', content: '{"n": 3}' }
  ]);
  const ctx = { workspace: ws, sandbox: new InlineSandbox() };
  const out = await executeTool('run_javascript', { code: 'const { sum } = require("./lib/sum");\nconsole.log(sum(2, 3), require("./data.json").n);\nreturn sum(1, 1);' }, ctx);
  assert.match(out, /5 3/);
  assert.match(out, /Returned: 2/);
  const esm = await executeTool('run_javascript', { code: 'import { twice } from "./lib/esm.mjs";\nimport seven from "./lib/esm.mjs";\nconsole.log(twice(seven));' }, ctx);
  assert.match(esm, /14/);
  const tests = await executeTool('run_javascript', { code: 'test("adds", () => assert.equal(1 + 1, 2));\ntest("fails", () => assert.deepStrictEqual({ a: 1 }, { a: 2 }));' }, ctx);
  assert.match(tests, /ok 1 - adds/);
  assert.match(tests, /not ok 2 - fails/);
  assert.match(tests, /1 test failed/);
  const error = await executeTool('run_javascript', { code: 'require("lodash")' }, ctx);
  assert.match(error, /Cannot load package "lodash"/);
});

test('skills list only names and load bodies on demand', async () => {
  const requests = [];
  const files = {
    'https://x/skills/index.json': JSON.stringify([{ name: 'debugging', description: 'Fix bugs.', path: 'debugging/SKILL.md' }]),
    'https://x/skills/debugging/SKILL.md': '---\nname: debugging\ndescription: Fix bugs.\n---\n\n# Steps\nReproduce first.'
  };
  const fetchImpl = async (url) => { requests.push(url); return new Response(files[url] ?? 'missing', { status: files[url] ? 200 : 404 }); };
  const ws = await project([{ path: '.oasis/skills/house/SKILL.md', content: '---\nname: house-style\ndescription: >\n  Our style.\n---\nUse tabs.' }]);
  const skills = new SkillLibrary({ baseURL: 'https://x/skills', fetchImpl, workspace: ws });
  const section = await skills.promptSection();
  assert.match(section, /- debugging: Fix bugs\./);
  assert.match(section, /- house-style: Our style\./);
  assert.equal(requests.length, 1);
  const loaded = await executeTool('load_skill', { name: 'debugging' }, { workspace: ws, skills });
  assert.match(loaded, /Reproduce first/);
  assert.match(await executeTool('load_skill', { name: 'house-style' }, { workspace: ws, skills }), /Use tabs/);
  assert.equal(parseSkill('no front matter', 'x').name, 'x');
});

test('zip round trip compresses and is readable by unzip', async () => {
  const big = 'const x = 1;\n'.repeat(2000);
  const zip = createZip([{ path: 'a.txt', content: 'hello' }, { path: 'dir/b.txt', content: 'wörld' }, { path: 'big.js', content: big }]);
  assert.ok(zip.length < big.length / 10, 'export is deflate-compressed');
  const files = await readZip(zip);
  assert.deepEqual(files.map((f) => [f.path, new TextDecoder().decode(f.bytes)]), [['a.txt', 'hello'], ['dir/b.txt', 'wörld'], ['big.js', big]]);
  await assert.rejects(readZip(new TextEncoder().encode('not a zip')), /Not a zip file/);
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'oasis-zipout-'));
  writeFileSync(join(dir, 'out.zip'), zip);
  let listing;
  try { listing = execFileSync('unzip', ['-t', 'out.zip'], { cwd: dir, encoding: 'utf8' }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  assert.match(listing, /No errors detected/);
});

test('zip import reads deflate archives and strips the top folder', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'oasis-zip-'));
  mkdirSync(join(dir, 'proj/src'), { recursive: true });
  writeFileSync(join(dir, 'proj/src/a.js'), 'x'.repeat(5000));
  try { execFileSync('zip', ['-qr', 'out.zip', 'proj'], { cwd: dir }); } catch { return; }
  const files = await readZip(await readFile(join(dir, 'out.zip')));
  assert.deepEqual(files.map((f) => f.path), ['src/a.js']);
  assert.equal(files[0].bytes.length, 5000);
});

test('repository references parse', () => {
  assert.deepEqual(parseRepo('https://github.com/FAHTHIZ/oasis.git'), { owner: 'FAHTHIZ', repo: 'oasis', branch: '' });
  assert.deepEqual(parseRepo('a/b@dev'), { owner: 'a', repo: 'b', branch: 'dev' });
  assert.equal(parseRepo('not a repo'), null);
});

function githubMock() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push(method + ' ' + url);
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    const path = url.replace('https://api.github.com', '');
    if (path === '/repos/o/r') return json({ default_branch: 'main', private: false });
    if (path === '/repos/o/r/commits/main') return json({ sha: 'c0', commit: { tree: { sha: 't0' } } });
    if (path === '/repos/o/r/git/trees/t0?recursive=1') return json({ tree: [{ type: 'blob', path: 'a.js', sha: 's1', size: 5 }, { type: 'blob', path: 'logo.png', sha: 's2', size: 9 }, { type: 'tree', path: 'src' }] });
    if (url === 'https://raw.githubusercontent.com/o/r/c0/a.js') return new Response('hello');
    if (path === '/repos/o/r/git/ref/heads/fix') return json({ message: 'Not Found' }, 404);
    if (path === '/repos/o/r/git/commits/c0') return json({ tree: { sha: 't0' } });
    if (path === '/repos/o/r/git/blobs' && method === 'POST') return json({ sha: 'b1' });
    if (path === '/repos/o/r/git/trees' && method === 'POST') return json({ sha: 't1' });
    if (path === '/repos/o/r/git/commits' && method === 'POST') return json({ sha: 'c1abcdef' });
    if (path === '/repos/o/r/git/refs' && method === 'POST') return json({ ref: 'refs/heads/fix' });
    if (path === '/repos/o/r/pulls' && method === 'POST') return json({ number: 5, html_url: 'https://github.com/o/r/pull/5' });
    return json({ message: 'unexpected ' + method + ' ' + path }, 500);
  };
  return { calls, fetchImpl };
}

test('GitHub import skips binaries and push commits on a new branch with a PR', async () => {
  const { calls, fetchImpl } = githubMock();
  const gh = new GitHub({ token: 't', fetchImpl });
  const imported = await gh.importRepo('o/r');
  assert.deepEqual(imported.files.map((f) => f.path), ['a.js']);
  assert.deepEqual(imported.skipped, ['logo.png']);
  const ws = await Workspace.create(new MemoryStore(), { name: 'r', source: imported.source, files: imported.files });
  await ws.write('a.js', 'hello world');
  const result = await gh.push(ws, { branch: 'fix', message: 'Fix', openPullRequest: true });
  assert.match(result.summary, /Pushed 1 file to o\/r on fix \(c1abcde\)/);
  assert.match(result.summary, /pull request #5/);
  assert.ok(calls.includes('POST https://api.github.com/repos/o/r/git/refs'));
  assert.deepEqual(await ws.changes(), []);
  await assert.rejects(gh.push(ws, { branch: '../x', message: 'm' }), /Invalid branch/);
});

test('OpenAI-compatible streaming assembles text and tool calls', async () => {
  const sse = [
    { choices: [{ delta: { content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo', tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] } }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } }
  ].map((d) => 'data: ' + JSON.stringify(d) + '\n\n').join('') + 'data: [DONE]\n\n';
  let body;
  const fetchImpl = async (url, init) => { body = JSON.parse(init.body); return new Response(sse, { headers: { 'content-type': 'text/event-stream' } }); };
  let streamed = '';
  const result = await chat({ protocol: 'openai', baseURL: 'https://api.example/v1', apiKey: 'k', model: 'm' }, { messages: [{ role: 'user', content: 'hi' }], tools: TOOL_DEFINITIONS, fetchImpl, onText: (d) => { streamed += d; } });
  assert.equal(result.content, 'Hello');
  assert.equal(streamed, 'Hello');
  assert.equal(result.tool_calls[0].function.arguments, '{"path":"a"}');
  assert.deepEqual(result.usage, { input: 10, output: 4 });
  assert.equal(body.stream, true);
});

test('Anthropic conversion keeps tool results paired', () => {
  const converted = toAnthropic([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'data' }
  ]);
  const flat = JSON.stringify(converted);
  assert.match(flat, /"tool_use"/);
  assert.match(flat, /"tool_result"/);
  assert.match(flat, /sys/);
  assert.ok(PRESETS.anthropic && PRESETS.openrouter && PRESETS.ollama);
});

function scripted(replies) {
  const seen = [];
  return {
    seen,
    chatImpl: async (config, request) => {
      seen.push(request.messages);
      const next = replies.shift();
      if (!next) return { content: 'done', tool_calls: [] };
      return typeof next === 'function' ? next(request) : next;
    }
  };
}

test('agent edits a file, runs its test and answers', async () => {
  const ws = await project([{ path: 'add.js', content: 'module.exports = (a, b) => a - b;\n' }]);
  const { chatImpl, seen } = scripted([
    { content: '', tool_calls: [{ id: '1', function: { name: 'read_file', arguments: '{"path":"add.js"}' } }] },
    { content: '', tool_calls: [{ id: '2', function: { name: 'edit_file', arguments: '{"path":"add.js","old_string":"a - b","new_string":"a + b"}' } }] },
    { content: '', tool_calls: [{ id: '3', function: { name: 'run_javascript', arguments: '{"code":"assert.equal(require(\\"./add\\")(2, 3), 5); console.log(\\"ok\\")"}' } }] },
    { content: 'Fixed add.js and verified 2 + 3 = 5.', tool_calls: [] }
  ]);
  const events = [];
  const agent = new Agent({
    getConfig: () => ({ mode: 'edits' }),
    getContext: () => ({ workspace: ws, sandbox: new InlineSandbox() }),
    approve: async () => { throw new Error('should not ask in edits mode'); },
    onEvent: (e) => events.push(e),
    chatImpl
  });
  const answer = await agent.send('Fix add.js');
  assert.equal(answer, 'Fixed add.js and verified 2 + 3 = 5.');
  assert.equal(await ws.read('add.js'), 'module.exports = (a, b) => a + b;\n');
  const results = events.filter((e) => e.type === 'tool_result');
  assert.deepEqual(results.map((e) => e.ok), [true, true, true]);
  assert.match(results[2].content, /ok/);
  assert.match(seen[0][0].content, /You are OASIS/);
});

test('agent repairs text tool calls, aliases and broken JSON from open models', async () => {
  const ws = await project([{ path: 'a.txt', content: 'hello' }]);
  const { chatImpl } = scripted([
    { content: '<tool_call>{"name": "read_file", "arguments": {"path": "a.txt"}}</tool_call>', tool_calls: [] },
    { content: '', tool_calls: [{ id: 'x', function: { name: 'ReadFile', arguments: "{'path': 'a.txt',}" } }] },
    { content: 'It says hello.', tool_calls: [] }
  ]);
  const events = [];
  const agent = new Agent({ getConfig: () => ({ mode: 'ask' }), getContext: () => ({ workspace: ws }), approve: async () => true, onEvent: (e) => events.push(e), chatImpl });
  assert.equal(await agent.send('read a.txt'), 'It says hello.');
  const results = events.filter((e) => e.type === 'tool_result');
  assert.equal(results.length, 2);
  assert.ok(results.every((e) => e.ok && /hello/.test(e.content)));
  assert.ok(events.some((e) => e.type === 'repaired'));
});

test('agent asks before writing in ask mode and respects a refusal', async () => {
  const ws = await project();
  const { chatImpl } = scripted([
    { content: '', tool_calls: [{ id: '1', function: { name: 'write_file', arguments: '{"path":"x.txt","content":"x"}' } }] },
    { content: 'Okay, I did not write it.', tool_calls: [] }
  ]);
  const asked = [];
  const agent = new Agent({ getConfig: () => ({ mode: 'ask' }), getContext: () => ({ workspace: ws }), approve: async (req) => { asked.push(req.name); return false; }, chatImpl });
  await agent.send('write x');
  assert.deepEqual(asked, ['write_file']);
  assert.equal(await ws.exists('x.txt'), false);
  assert.match(agent.messages.find((m) => m.role === 'tool').content, /declined/);
});

test('browser agent validates tool calls in the shared kernel before approval', async () => {
  const ws = await project();
  const asked = [];
  const { chatImpl } = scripted([
    { content: '', tool_calls: [{ id: 'invalid-write', function: { name: 'write_file', arguments: JSON.stringify({ path: 'blocked.txt' }) } }] },
    { content: 'The invalid call was rejected.', tool_calls: [] }
  ]);
  const agent = new Agent({
    getConfig: () => ({ mode: 'ask' }),
    getContext: () => ({ workspace: ws }),
    approve: async (request) => { asked.push(request.name); return true; },
    chatImpl
  });
  await agent.send('Create blocked.txt.');
  const toolResult = agent.messages.find((message) => message.role === 'tool');
  assert.match(toolResult.content, /Invalid arguments for write_file/);
  assert.deepEqual(asked, [], 'invalid tool calls are rejected before requesting permission');
  assert.deepEqual(await ws.paths(), [], 'invalid calls never reach the workspace handler');
});

test('agent stops cleanly and keeps a valid history', async () => {
  const ws = await project([{ path: 'a.txt', content: 'a' }]);
  let agent;
  const chatImpl = async (config, request) => {
    if (request.messages.some((m) => m.role === 'tool')) {
      agent.stop();
      throw new DOMException('Stopped', 'AbortError');
    }
    return { content: '', tool_calls: [{ id: '1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }, { id: '2', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] };
  };
  const events = [];
  agent = new Agent({ getConfig: () => ({}), getContext: () => ({ workspace: ws }), approve: async () => true, onEvent: (e) => events.push(e), chatImpl });
  assert.equal(await agent.send('go'), '');
  assert.ok(events.some((e) => e.type === 'stopped'));
  const assistant = agent.messages.find((m) => m.tool_calls);
  const answered = agent.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  for (const call of assistant.tool_calls) assert.ok(answered.includes(call.id));
});

test('agent compacts long sessions with a summary', async () => {
  const ws = await project();
  const { chatImpl } = scripted([
    (request) => ({ content: request.tools.length ? 'final' : 'SUMMARY', tool_calls: [] })
  ]);
  const agent = new Agent({ getConfig: () => ({ contextChars: 1000 }), getContext: () => ({ workspace: ws }), approve: async () => true, chatImpl: async (c, r) => (r.tools.length ? { content: 'final', tool_calls: [] } : { content: 'SUMMARY of work', tool_calls: [] }) });
  void chatImpl;
  agent.load(Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(200) })));
  assert.equal(await agent.send('next'), 'final');
  assert.match(agent.messages[0].content, /SUMMARY of work/);
});

test('system prompt includes project instructions and skills', async () => {
  const ws = await project([{ path: 'OASIS.md', content: 'Always use tabs.' }, { path: 'src/a.js', content: '' }]);
  const skills = { promptSection: async () => 'Skills (call load_skill…):\n- testing: Write tests.' };
  const prompt = await buildSystemPrompt({ workspace: ws, skills });
  assert.match(prompt, /Always use tabs\./);
  assert.match(prompt, /Top level: OASIS.md, src\//);
  assert.match(prompt, /- testing: Write tests\./);
});

test('markdown renderer escapes HTML and only links http(s)', async () => {
  const { renderMarkdown } = await import('../app/markdown.mjs');
  const html = renderMarkdown('<img src=x onerror=alert(1)> **b** [x](javascript:alert(1)) [ok](https://a.b/c?d=1&e=2)\n\n```js\n<b>\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.ok(!html.includes('<img'));
  assert.ok(!/href="javascript/i.test(html));
  assert.match(html, /<strong>b<\/strong>/);
  assert.match(html, /href="https:\/\/a\.b\/c\?d=1&amp;e=2"/);
  assert.match(html, /<code data-lang="js">&lt;b&gt;<\/code>/);
  assert.match(html, /<table>/);
  // CommonMark/GFM structure from marked: nesting, links with parentheses, images never load.
  const rich = renderMarkdown('- a\n  - b\n\n[wiki](https://en.wikipedia.org/wiki/Foo_(bar)) ![p](https://t.example/x.png) ![q](javascript:alert(1)) <a href="javascript:1">a</a>');
  assert.match(rich, /<li>a<ul>\s*<li>b<\/li>/);
  assert.match(rich, /href="https:\/\/en\.wikipedia\.org\/wiki\/Foo_\(bar\)"/);
  assert.ok(!rich.includes('<img') && !/href="javascript/i.test(rich) && !rich.includes('<a href="javascript'));
  assert.match(rich, /&lt;a href=&quot;javascript:1&quot;&gt;/);
});

test('test server serves only the connected workspace and shared modules', async () => {
  const { resolveAppPath, appSharedModules, startAppServer } = await import('../src/app-server.mjs');
  const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const shared = new Set(await appSharedModules(root));
  assert.ok([...shared].some((file) => file.endsWith('tool-call-repair.mjs')));
  assert.deepEqual(resolveAppPath(root, '/', shared), { redirect: '/app/' });
  assert.equal(resolveAppPath(root, '/app/../package.json', shared), null);
  assert.equal(resolveAppPath(root, '/app/%2e%2e/package.json', shared), null);
  assert.equal(resolveAppPath(root, '/src/agent.mjs', shared), null);
  assert.deepEqual(resolveAppPath(root, '/app/skills/index.json', shared), { index: true });
  const server = await startAppServer({ root, port: 0 });
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const page = await fetch(base + '/app/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>OASIS — Coding Agent Workspace<\/title>/);
    assert.equal((await fetch(base + '/app/sw.js')).status, 404, 'the connected workspace has no PWA service worker');
    assert.equal((await fetch(base + '/app/manifest.webmanifest')).status, 404, 'the connected workspace has no PWA manifest');
    assert.equal((await fetch(base + '/package.json')).status, 404);
    const vendored = await fetch(base + '/vendor/yaml/browser/index.js');
    assert.equal(vendored.status, 200);
    assert.match(vendored.headers.get('content-type') || '', /javascript/);
    assert.equal((await fetch(base + '/vendor/yaml/package.json')).status, 404, 'only the browser build folder is served');
    assert.equal((await fetch(base + '/vendor/ajv/dist/ajv.js')).status, 404, 'only listed packages are served');
    assert.equal((await fetch(base + '/vendor/yaml/browser/../../../package.json')).status, 404);
    assert.equal((await fetch(base + '/app/skills/index.json', { method: 'POST' })).status, 405);
  } finally { server.close(); }
});

test('agent reads a note typed while it works before its next step, even after a final answer', async () => {
  const ws = await project([{ path: 'a.txt', content: 'hello' }]);
  let agent;
  const { chatImpl, seen } = scripted([
    { content: '', tool_calls: [{ id: '1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
    { content: 'It says hello.', tool_calls: [] },
    { content: 'Also: it is five letters.', tool_calls: [] }
  ]);
  const events = [];
  agent = new Agent({
    getConfig: () => ({ mode: 'ask' }), getContext: () => ({ workspace: ws }), approve: async () => true, chatImpl,
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'tool_result') assert.equal(agent.steer('keep it short'), true);
      if (e.type === 'assistant' && e.content === 'It says hello.') assert.equal(agent.steer('and count the letters'), true);
    }
  });
  assert.equal(await agent.send('read a.txt'), 'Also: it is five letters.');
  assert.equal(seen.length, 3);
  assert.ok(seen[1].some((m) => m.role === 'user' && m.content === 'keep it short'), 'a note after a tool reaches the next step');
  assert.ok(seen[2].some((m) => m.role === 'user' && m.content === 'and count the letters'), 'a note during the final answer keeps the turn going');
  assert.ok(events.some((e) => e.type === 'steer' && e.content === 'keep it short'), 'a steer is its own event, not a new user turn');
  assert.ok(events.some((e) => e.type === 'steered' && e.delivered >= 1), 'the agent says when it read the note');
  assert.equal(agent.steer('too late'), false);
});

test('agent sends attached images as image parts, and Anthropic gets image blocks', async () => {
  const ws = await project();
  const { chatImpl, seen } = scripted([{ content: 'A red square.', tool_calls: [] }]);
  const events = [];
  const agent = new Agent({ getConfig: () => ({ mode: 'ask' }), getContext: () => ({ workspace: ws }), approve: async () => true, onEvent: (e) => events.push(e), chatImpl });
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
  assert.equal(await agent.send('what is this?', { images: [{ mediaType: 'image/png', data: png, name: 'a.png' }] }), 'A red square.');
  const user = seen[0].find((m) => m.role === 'user');
  assert.deepEqual(user.content[0], { type: 'text', text: 'what is this?' });
  assert.equal(user.content[1].image_url.url, 'data:image/png;base64,' + png);
  assert.equal(events.find((e) => e.type === 'user').images, 1);
  assert.equal(textOf(user.content), 'what is this?\n[image]');
  const { messages } = toAnthropic([user]);
  assert.deepEqual(messages[0].content.map((b) => b.type), ['text', 'image']);
  assert.deepEqual(messages[0].content[1].source, { type: 'base64', media_type: 'image/png', data: png });
});


test('steering queue is bounded by message count and note size', () => {
  const events = [];
  const agent = new Agent({
    getConfig: () => ({}), getContext: () => ({}), approve: async () => true,
    onEvent: (event) => events.push(event), chatImpl: async () => ({ content: 'unused', tool_calls: [] })
  });
  agent.running = true;
  for (let i = 0; i < 20; i++) assert.equal(agent.steer('note ' + i), true);
  assert.equal(agent.steer('one too many'), false);
  assert.equal(agent.steering.length, 20);
  assert.equal(events.length, 20, 'rejected notes do not emit misleading user events');

  const oversized = new Agent({
    getConfig: () => ({}), getContext: () => ({}), approve: async () => true,
    chatImpl: async () => ({ content: 'unused', tool_calls: [] })
  });
  oversized.running = true;
  assert.equal(oversized.steer('x'.repeat(12_001)), false);
  assert.equal(oversized.steering.length, 0);

  const restored = new Agent({
    getConfig: () => ({}), getContext: () => ({}), approve: async () => true,
    chatImpl: async () => ({ content: 'unused', tool_calls: [] })
  });
  restored.load([], [...Array.from({ length: 22 }, (_, i) => 'saved ' + i), 'x'.repeat(12_001), 42, '   ']);
  assert.deepEqual(restored.steering, Array.from({ length: 20 }, (_, i) => 'saved ' + i));
  restored.reset();
  assert.deepEqual(restored.steering, []);
});

test('a steering note queued on the last allowed step is carried into the next send', async () => {
  const ws = await project([{ path: 'a.txt', content: 'hello' }]);
  let agent;
  const { chatImpl, seen } = scripted([
    { content: '', tool_calls: [{ id: '1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
    { content: 'I followed the note.', tool_calls: [] }
  ]);
  agent = new Agent({
    getConfig: () => ({ mode: 'ask' }),
    getContext: () => ({ workspace: ws }),
    approve: async () => true,
    chatImpl,
    onEvent: (event) => {
      if (event.type === 'tool_result') assert.equal(agent.steer('finish the check briefly'), true);
    }
  });

  assert.match(await agent.send('read a.txt', { maxSteps: 1 }), /Stopped after 1 steps/);
  assert.equal(agent.steering.length, 1);

  // A page reload creates a new Agent instance. Restore the saved messages and
  // pending queue, then confirm the visible note is actually sent to the model.
  const restored = new Agent({
    getConfig: () => ({ mode: 'ask' }),
    getContext: () => ({ workspace: ws }),
    approve: async () => true,
    chatImpl
  });
  restored.load(agent.messages, agent.steering);
  assert.equal(restored.steering.length, 1);
  assert.equal(await restored.send('continue'), 'I followed the note.');

  const secondPrompt = seen[1];
  const carriedIndex = secondPrompt.findIndex((message) => message.role === 'user' && message.content === 'finish the check briefly');
  const nextPromptIndex = secondPrompt.findIndex((message) => message.role === 'user' && message.content === 'continue');
  assert.ok(carriedIndex >= 0, 'the queued note is included in the next model request');
  assert.ok(nextPromptIndex > carriedIndex, 'the carried note stays in chronological order');
  assert.equal(restored.steering.length, 0);
});

test('the app import map covers every package shared modules import, and the CSP allows it', async () => {
  const { createHash } = await import('node:crypto');
  const { appModuleGraph, APP_PACKAGES } = await import('../src/app-server.mjs');
  const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  const inline = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(inline, 'app/index.html has an import map');
  const map = JSON.parse(inline[1]).imports;
  for (const name of (await appModuleGraph(root)).packages) assert.equal(map[name], '../vendor/' + name + '/' + APP_PACKAGES[name], name);
  const hash = "'sha256-" + createHash('sha256').update(inline[1]).digest('base64') + "'";
  assert.ok(html.includes("script-src 'self' " + hash), 'the CSP lists the import map hash ' + hash);
});
