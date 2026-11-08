import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { conversationHtml } from '../src/session-html.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
function session(root = '/work/proj') {
  return {
    root,
    config: { model: 'test-model' },
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: [{ type: 'text', text: 'Fix <b>add()</b> please, key sk-ant-api03-' + 'a'.repeat(90) }, { type: 'image_url', image_url: { url: PNG } }, { type: 'image_url', image_url: { url: 'https://evil.example/x.png' } }] },
      { role: 'user', content: '<system-reminder>internal</system-reminder>' },
      { role: 'assistant', content: 'Reading **math.js**. <script>alert(1)</script> [bad](javascript:alert(1)) [ok](https://example.com)', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"math.js"}' } }, { id: 'c2', type: 'function', function: { name: 'run_command', arguments: '{"command":"npm test"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'export const add = (a, b) => a - b;' },
      { role: 'assistant', content: 'Done.\n\n```js\nadd(1, 2)\n```' }
    ]
  };
}

test('HTML export is self-contained: CSP blocks scripts and remote loads', () => {
  const html = conversationHtml(session(), { now: new Date('2026-11-08T10:00:00Z') });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /evil\.example/);
  assert.match(html, /<a href="https:\/\/example\.com"/);
  assert.match(html, /&lt;b&gt;add\(\)&lt;\/b&gt;/, 'user text is escaped, not rendered');
  assert.match(html, /<strong>math\.js<\/strong>/, 'assistant Markdown is rendered');
  assert.doesNotMatch(html, /<button/, 'no buttons that need a script');
  assert.match(html, /src="data:image\/png;base64,iVBORw0KGgo="/);
});

test('HTML export pairs tool calls with results, skips reminders and redacts secrets', () => {
  const html = conversationHtml(session());
  assert.doesNotMatch(html, /internal/);
  assert.doesNotMatch(html, /sk-ant-api03-a{20}/);
  assert.match(html, /\[redacted\]/);
  assert.match(html, /<b>read_file<\/b><span>math\.js<\/span>/);
  assert.match(html, /a - b;/);
  assert.match(html, /<b>run_command<\/b><span>npm test<\/span><em class="status">no result<\/em>/);
  assert.match(html, /1 message · 2 tool steps/);
  assert.match(html, /Model: test-model/);
});

test('/export FILE.html writes the HTML page, FILE.md still writes Markdown', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'oasis-export-'));
  const s = session(root);
  const html = await runBuiltinCommand('export', 'chat.html', { root, session: s, env: {} });
  assert.match(html.output, /Exported \d+ messages to chat\.html/);
  assert.match(await readFile(path.join(root, 'chat.html'), 'utf8'), /^<!doctype html>/);
  await runBuiltinCommand('export', 'chat.md', { root, session: s, env: {} });
  assert.match(await readFile(path.join(root, 'chat.md'), 'utf8'), /^# Oasis conversation/);
});
