import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { argvSleepSeconds, leadingSleepSeconds, longSleepError } from '../src/sleep-guard.mjs';
import { executeTool } from '../src/tools.mjs';

test('detects only sleeps that start the command', () => {
  assert.equal(leadingSleepSeconds('sleep 60'), 60);
  assert.equal(leadingSleepSeconds('  sleep 2m && gh run view'), 120);
  assert.equal(leadingSleepSeconds('sleep 1m 30s; curl x'), 90);
  assert.equal(leadingSleepSeconds('sleep 300 & echo started'), 300);
  assert.equal(leadingSleepSeconds('npm start & sleep 30 && curl localhost:3000'), 0, 'a sleep later in the command is allowed');
  assert.equal(leadingSleepSeconds('sleepwalk 60'), 0);
  assert.equal(leadingSleepSeconds('sleep $DELAY'), 0);
  assert.equal(leadingSleepSeconds('Start-Sleep -Seconds 45; Get-Date', 'powershell'), 45);
  assert.equal(leadingSleepSeconds('Start-Sleep -Milliseconds 500', 'powershell'), 0.5);
  assert.equal(argvSleepSeconds('sleep', ['90']), 90);
  assert.equal(argvSleepSeconds('/bin/sleep', ['5']), 5);
  assert.equal(argvSleepSeconds('node', ['60']), 0);
  assert.match(longSleepError(60, {}), /monitor/);
  assert.equal(longSleepError(5, {}), '');
  assert.equal(longSleepError(60, { OASIS_ALLOW_LONG_SLEEP: '1' }), '');
});

test('run_command and run_shell refuse long leading sleeps before asking for approval', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-sleep-'));
  let asked = 0;
  const context = { approve: async () => { asked++; return true; }, env: process.env, session: { background: new Map() } };
  await assert.rejects(executeTool('run_command', { command: 'sleep', args: ['120'] }, { ...context, root }), /120-second sleep[\s\S]*monitor/);
  await assert.rejects(executeTool('run_shell', { command: 'sleep 120 && echo done' }, { ...context, root }), /120-second sleep/);
  assert.equal(asked, 0);
});
