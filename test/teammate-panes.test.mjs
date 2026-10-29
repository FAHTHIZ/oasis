import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, readdir, chmod, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { resolveTeammateMode } from '../src/teammate-panes.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };

test('resolveTeammateMode: auto and tmux need an enclosing tmux', () => {
  assert.equal(resolveTeammateMode('auto', {}), 'in-process');
  assert.equal(resolveTeammateMode(undefined, { TMUX: '/tmp/x' }), 'tmux');
  assert.equal(resolveTeammateMode('tmux', {}), 'in-process');
  assert.equal(resolveTeammateMode('in-process', { TMUX: '/tmp/x' }), 'in-process');
});

test('team members get a tmux pane that mirrors their activity', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-panes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const calls = path.join(root, 'tmux-calls.txt');
  await writeFile(path.join(bin, 'tmux'), '#!/bin/sh\necho "$@" >> ' + JSON.stringify(calls) + '\ncase "$1" in split-window) echo "%7";; esac\n');
  await chmod(path.join(bin, 'tmux'), 0o755);
  const paneDir = path.join(root, 'panes');
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TMUX: '/tmp/fake,1,0', OASIS_TEAMMATE_MODE: 'tmux', OASIS_TEAM_PANE_DIR: paneDir, HOME: root, OASIS_CONFIG_DIR: path.join(root, 'cfg') };
  const { config } = await scriptedModel(t, [
    toolCall('tc', 'team_create', { name: 'Review Team' }),
    toolCall('launch', 'task', { description: 'route checker', prompt: 'Check the routes.', team_id: 'team_1' }),
    { content: 'Routes look fine, says the teammate.' },
    { content: 'lead done' }
  ]);
  config.maxSteps = 10;
  const session = await createSession({ root, config, settings, env });
  await runAgentTurn(session, 'start a team', { env });
  closeSession(session);
  const log = await readFile(calls, 'utf8');
  assert.match(log, /^split-window -d -h -P -F #\{pane_id\} tail -n \+1 -f /m);
  assert.match(log, /select-pane -t %7 -T Review Team \/ route checker/);
  assert.match(log, /kill-pane -t %7/);
  const [file] = (await readdir(path.join(paneDir, 'oasis-teams')));
  const mirrored = await readFile(path.join(paneDir, 'oasis-teams', file), 'utf8');
  assert.match(mirrored, /== Review Team \/ route checker/);
  assert.match(mirrored, /> Check the routes\./);
  assert.match(mirrored, /\[completed\]/);
});
