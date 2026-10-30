import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandAvailable, findCommandPath } from '../src/command-lookup.mjs';
import { planPackageInstall } from '../src/installer.mjs';

function makeExecutable(directory, name) {
  const file = path.join(directory, name);
  if (process.platform === 'win32') writeFileSync(file, '@echo off\r\nexit /b 0\r\n', 'utf8');
  else {
    writeFileSync(file, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(file, 0o755);
  }
  return file;
}

test('command lookup finds executables on PATH without which or where', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'oasis-path-'));
  try {
    const executable = makeExecutable(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const env = { PATH: directory, PATHEXT: process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM' };
    assert.equal(findCommandPath('npm', env), executable);
    assert.equal(commandAvailable('npm', env), true);
    assert.equal(commandAvailable('which', env), false);
    assert.equal(commandAvailable('not-installed', env), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('package installation checks the supplied PATH environment', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'oasis-npm-'));
  try {
    makeExecutable(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const plan = planPackageInstall({
      packageName: 'omniroute',
      ecosystem: 'npm-global',
      env: { PATH: directory, PATHEXT: process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM' }
    });
    assert.equal(plan.command, 'npm');
    assert.deepEqual(plan.args, ['install', '--global', 'omniroute']);
    assert.equal(commandAvailable(plan.command, { PATH: directory }), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('command lookup accepts a direct executable path', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'oasis-direct-'));
  try {
    const executable = makeExecutable(directory, process.platform === 'win32' ? 'oasis-probe.cmd' : 'oasis-probe');
    assert.equal(findCommandPath(executable, { PATH: '' }), executable);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
