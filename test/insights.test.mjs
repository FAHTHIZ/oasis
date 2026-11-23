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

// With no saved sessions, `oasis insights` wrote an empty HTML report and
// printed its path. Nothing is written now.
test('insights writes no report when there are no sessions', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-insights-empty-'));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  const { file, stats } = await writeInsightsReport({ env });
  assert.equal(stats.sessions, 0);
  assert.equal(file, '');
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(path.join(home, '.config', 'oasis', 'insights')).catch(() => []), []);
});

// Sessions with no tool calls printed "Top tools: ." with nothing listed.
test('insights summary leaves out the tool line when no tools ran', async () => {
  const { insightsSummaryText } = await import('../src/insights.mjs');
  const text = insightsSummaryText({ sessions: 2, userTurns: 3, toolCalls: 0, days: 30, projects: new Map([['p', 2]]), tools: new Map(), toolErrors: 0, denials: 0, corrections: 0 });
  assert.doesNotMatch(text, /Top tools/);
  assert.match(text, /Top projects: p \(2\)\./);
});

test('insights report failed calls that took effect, rehearsal misses and drifted resumes', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-insights-effects-'));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  const dir = path.join(home, '.config', 'oasis', 'sessions', 'eff');
  await mkdir(dir, { recursive: true });
  const run = (id, command, args = []) => ({ id, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command, args }) } });
  const divergent = JSON.stringify({ exitCode: 0, rehearsal: { status: 'ok', modified: ['dist/a.js'], divergence: { unrehearsed: ['dist/build-1712.log'], note: 'n' } } });
  const messages = [
    { role: 'system', content: 's' },
    { role: 'user', content: '<workspace-drift>The workspace changed since this conversation was last saved. 1 new commit.</workspace-drift>\n\ncontinue' },
    { role: 'assistant', content: null, tool_calls: [run('r1', 'npm', ['run', 'build']), run('r2', 'make', ['deploy'])] },
    { role: 'tool', tool_call_id: 'r1', name: 'run_command', content: divergent },
    { role: 'tool', tool_call_id: 'r2', name: 'run_command', content: JSON.stringify({ error: 'timed out', afterFailure: { state: 'applied', findings: ['deploy.lock exists'], note: 'This call reported an error, but OASIS checked its targets: it took effect.' } }) },
    { role: 'assistant', content: null, tool_calls: [run('r3', 'npm', ['run', 'build'])] },
    // A truncated result still counts through its markers.
    { role: 'tool', tool_call_id: 'r3', name: 'run_command', content: divergent.slice(0, -10) + '\n[Tool result truncated.]' }
  ];
  await writeFile(path.join(dir, '22222222-2222-3333-4444-555555555555.json'), JSON.stringify({ schemaVersion: 1, id: '22222222-2222-3333-4444-555555555555', workspaceRoot: '/work/site', updatedAt: new Date().toISOString(), provider: { model: 'm' }, messages }));
  const stats = await collectInsights({ env });
  assert.equal(stats.effects.afterFailure, 1);
  assert.equal(stats.effects.afterFailureBy.get('make deploy'), 1);
  assert.equal(stats.effects.divergence, 2);
  assert.equal(stats.effects.divergenceBy.get('npm run build'), 2);
  assert.equal(stats.effects.driftResumes, 1);
  assert.equal(stats.userTurns, 1, 'the drift note is not a prompt of its own');
  const { insightsSummaryText } = await import('../src/insights.mjs');
  const text = insightsSummaryText(stats);
  assert.match(text, /Effects: 1 failed call had in fact taken effect .*: make deploy\./);
  assert.match(text, /Effects: 2 approved commands changed more files than their rehearsal showed: npm run build ×2\./);
  assert.match(text, /Effects: 1 resumed session found the workspace changed/);
  const report = await writeInsightsReport({ env, days: 30 });
  const html = await readFile(report.file, 'utf8');
  assert.match(html, /<h2>Effects<\/h2>/);
  assert.match(html, /The rehearsal of npm run build missed files the real run changed 2 times/);
  assert.match(html, /also changed dist\/build-1712\.log/);
});
