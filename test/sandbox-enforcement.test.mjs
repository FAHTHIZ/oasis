import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { runWorkspaceCommand } from '../src/tools.mjs';
import { executePowerTool } from '../src/power-tools.mjs';
import { wrapCommand } from '../src/sandbox.mjs';

const unavailableSandbox = {
  enabled: true,
  available: false,
  kind: 'none',
  reason: 'sandbox helper unavailable in regression test'
};

test('single-executable commands fail closed before approval when an enabled sandbox is unavailable', async () => {
  let approvalCalls = 0;
  await assert.rejects(
    () => runWorkspaceCommand(os.tmpdir(), process.execPath, ['--version'], {
      sandbox: unavailableSandbox,
      approval: async () => { approvalCalls++; return true; }
    }),
    /sandbox is enabled but unavailable; refusing to run commands without isolation/
  );
  assert.equal(approvalCalls, 0, 'must not offer an approval that would run outside the requested sandbox');
});

test('shell commands fail closed before approval when an enabled sandbox is unavailable', async () => {
  let approvalCalls = 0;
  await assert.rejects(
    () => executePowerTool('run_shell', { command: 'echo should-not-run' }, {
      sandbox: unavailableSandbox,
      approval: async () => { approvalCalls++; return true; },
      env: process.env
    }, os.tmpdir()),
    /sandbox is enabled but unavailable; refusing to run commands without isolation/
  );
  assert.equal(approvalCalls, 0, 'must not offer an approval that would run outside the requested sandbox');
});

test('direct sandbox wrapping also rejects an unavailable explicitly enabled sandbox', () => {
  assert.throws(
    () => wrapCommand(process.execPath, ['--version'], unavailableSandbox, os.tmpdir()),
    /sandbox is enabled but unavailable; refusing to run commands without isolation/
  );
});

test('free-form shell commands still require approval when only argv auto-approval is enabled', async () => {
  let approvalCalls = 0;
  const result = await executePowerTool('run_shell', { command: 'echo should-not-run' }, {
    sandbox: {
      enabled: true,
      available: true,
      kind: 'unknown-test-sandbox',
      autoAllowCommands: true,
      autoAllowShellCommands: false
    },
    approval: async () => { approvalCalls++; return false; },
    env: process.env
  }, os.tmpdir());

  assert.equal(approvalCalls, 1, 'free-form shell strings must not inherit argv auto-approval');
  assert.equal(result.approved, false);
  assert.match(result.message, /Nothing ran/);
});
