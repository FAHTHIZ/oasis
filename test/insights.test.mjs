import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectInsights, writeInsightsReport } from '../src/insights.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-insights-'));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  const dir = path.join(home, '.config', 'oasis', 'sessions', 'abc');
  await mkdir(dir, { recursive: true });
  const messages = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'add a <login> page' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'src/app.ts' }) } }, { id: 'c2', type: 'function', function: { name: 'run_command', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'edit_file', content: '{"ok":true}' },
    { role: 'tool', tool_call_id: 'c2', name: 'run_command', content: '{"error":"npm ERR missing script"}' },
    { role: 'user', content: 'no, that is wrong, use the existing form' },
    { role: 'user', content: '/review' }
  ];
  await writeFile(path.join(dir, '11111111-2222-3333-4444-555555555555.json'), JSON.stringify({ schemaVersion: 1, id: '11111111-2222-3333-4444-555555555555', workspaceRoot: '/work/webapp', updatedAt: new Date().toISOString(), provider: { model: 'claude-sonnet-5-5' }, messages }));
  await writeFile(path.join(dir, '99999999-2222-3333-4444-555555555555.json'), JSON.stringify({ schemaVersion: 1, id: 'x', workspaceRoot: '/work/old', updatedAt: '2020-01-01T00:00:00Z', provider: {}, messages }));
  return env;
}

test('collectInsights summarizes recent sessions only', async () => {
  const env = await fixture();
  const stats = await collectInsights({ env });
  assert.equal(stats.sessions, 1);
  assert.equal(stats.userTurns, 3);
  assert.equal(stats.toolCalls, 2);
  assert.equal(stats.toolErrors, 1);
  assert.equal(stats.corrections, 1);
  assert.equal(stats.projects.get('webapp'), 1);
  assert.equal(stats.extensions.get('.ts'), 1);
  assert.equal(stats.commands.get('/review'), 1);
});

test('/insights writes an escaped HTML report', async () => {
  const env = await fixture();
  const result = await runBuiltinCommand('insights', '', { root: os.tmpdir(), env });
  const file = /Report: (.+)$/m.exec(result.output)[1];
  const html = await readFile(file, 'utf8');
  assert.match(html, /<title>Oasis insights<\/title>/);
  assert.match(html, /webapp/);
  assert.match(html, /&lt;login&gt;/);
  assert.doesNotMatch(html, /<login>/);
  const narrated = await writeInsightsReport({ env, narrate: async () => 'You mostly build the webapp.' });
  assert.match(await readFile(narrated.file, 'utf8'), /You mostly build the webapp/);
});
