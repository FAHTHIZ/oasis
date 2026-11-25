// A routine takes the same --permission-mode spellings as the main command
// (manual, accept-edits, dont-ask) and stores the canonical name; bypass mode
// stays refused for unattended runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { createJob } from '../src/routines.mjs';

async function tempEnv() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-rtpm-'));
  return { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_SCHEDULED_RUN: '' };
}

test('routine permission modes accept the CLI spellings', async () => {
  const env = await tempEnv();
  for (const [given, stored] of [['accept-edits', 'acceptEdits'], ['manual', 'default'], ['dont-ask', 'dontAsk'], ['auto', 'auto'], ['acceptEdits', 'acceptEdits']]) {
    const job = await createJob({ schedule: 'in 30m', prompt: 'x', permissionMode: given }, { env });
    assert.equal(job.permissionMode, stored, given);
  }
});

test('routine permission mode refuses bypass and unknown names with the CLI spellings', async () => {
  const env = await tempEnv();
  for (const mode of ['bypass-permissions', 'bypassPermissions', 'yolo']) {
    await assert.rejects(createJob({ schedule: 'in 30m', prompt: 'x', permissionMode: mode }, { env }), /must be one of manual, accept-edits, plan, auto, dont-ask\./);
  }
});
