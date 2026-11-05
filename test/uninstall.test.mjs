import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { resolveUninstallPlan } from '../src/uninstall.mjs';

test('uninstall plan targets only the expected package in a global npm prefix', () => {
  const prefix = path.join(os.tmpdir(), 'oasis-global-prefix');
  const root = path.join(prefix, 'lib', 'node_modules', 'oasis-oss');
  const plan = resolveUninstallPlan(root, { name: 'oasis-oss' });
  assert.equal(plan.applicationRoot, path.resolve(root));
  assert.equal(plan.prefix, path.resolve(prefix));
  assert.deepEqual(plan.args, ['uninstall', '--global', '--prefix', path.resolve(prefix), 'oasis-oss']);
});

test('uninstall refuses project checkouts and local source directories', () => {
  for (const root of [
    path.join(os.tmpdir(), 'project', 'src'),
    path.join(os.tmpdir(), 'oasis'),
    path.join(os.tmpdir(), 'project', 'node_modules', 'not-oasis')
  ]) {
    assert.throws(() => resolveUninstallPlan(root, { name: 'oasis-oss' }), /global npm installation.*will not delete project files|package directory does not match its installed package name/i);
  }
});

test('uninstall refuses a different package even inside node_modules', () => {
  const root = path.join(os.tmpdir(), 'global', 'node_modules', 'another-package');
  assert.throws(() => resolveUninstallPlan(root, { name: 'another-package' }), /package name was not oasis-oss/i);
});

test('uninstall never targets project files or user data paths', () => {
  const prefix = path.join(os.tmpdir(), 'oasis-global-prefix');
  const root = path.join(prefix, 'node_modules', 'oasis-oss');
  const plan = resolveUninstallPlan(root, { name: 'oasis-oss' });
  assert.ok(plan.args.includes('--global'));
  assert.ok(!plan.args.includes(path.join(os.tmpdir(), 'projects')));
  assert.ok(!plan.args.includes(path.join(os.tmpdir(), '.config', 'oasis')));
});

test('uninstall computes the npm prefix for Windows and Unix layouts', () => {
  const win = resolveUninstallPlan('C:\\Users\\ada\\AppData\\Roaming\\npm\\node_modules\\oasis-oss', { name: 'oasis-oss' }, { pathImpl: path.win32 });
  assert.equal(win.prefix, 'C:\\Users\\ada\\AppData\\Roaming\\npm');
  assert.deepEqual(win.args, ['uninstall', '--global', '--prefix', 'C:\\Users\\ada\\AppData\\Roaming\\npm', 'oasis-oss']);
  const nvm = resolveUninstallPlan('C:\\nvm4w\\nodejs\\node_modules\\oasis-oss', { name: 'oasis-oss' }, { pathImpl: path.win32 });
  assert.equal(nvm.prefix, 'C:\\nvm4w\\nodejs');
  const unix = resolveUninstallPlan('/usr/local/lib/node_modules/oasis-oss', { name: 'oasis-oss' }, { pathImpl: path.posix });
  assert.equal(unix.prefix, '/usr/local');
  const home = resolveUninstallPlan('/home/ada/.npm-global/lib/node_modules/oasis-oss', { name: 'oasis-oss' }, { pathImpl: path.posix });
  assert.equal(home.prefix, '/home/ada/.npm-global');
  // A package at a drive or filesystem root has no safe prefix.
  assert.throws(() => resolveUninstallPlan('C:\\node_modules\\oasis-oss', { name: 'oasis-oss' }, { pathImpl: path.win32 }), /not a safe/);
  assert.throws(() => resolveUninstallPlan('/node_modules/oasis-oss', { name: 'oasis-oss' }, { pathImpl: path.posix }), /not a safe/);
  assert.throws(() => resolveUninstallPlan('/lib/node_modules/oasis-oss', { name: 'oasis-oss' }, { pathImpl: path.posix }), /not a safe/);
});

// The CLI end to end, with a fake npm that records whether it ran.
async function uninstallFixture() {
  const { mkdtemp, mkdir, cp, symlink, writeFile, chmod } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-uninstall-'));
  const prefix = path.join(base, 'prefix');
  const installed = path.join(prefix, 'lib', 'node_modules', 'oasis-oss');
  await mkdir(installed, { recursive: true });
  for (const entry of ['package.json', 'src', 'app', 'plugins', 'skills', 'evals']) {
    await cp(path.join(repo, entry), path.join(installed, entry), { recursive: true }).catch(() => {});
  }
  await symlink(path.join(repo, 'node_modules'), path.join(installed, 'node_modules'), 'dir').catch(() => {});
  const bin = path.join(base, 'bin');
  await mkdir(bin);
  const record = path.join(base, 'npm-called.json');
  await writeFile(path.join(bin, 'npm'), '#!/bin/sh\n' + JSON.stringify(process.execPath) + ' -e \'require("fs").writeFileSync(' + JSON.stringify(record) + ', JSON.stringify(process.argv.slice(1)))\' -- "$@"\n');
  await chmod(path.join(bin, 'npm'), 0o755);
  return { repo, base, prefix, installed, bin, record };
}

async function runUninstall(cli, args, { bin, input = '', home }) {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [cli, 'uninstall', ...args], { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  child.stdin.end(input);
  const code = await new Promise((resolve) => child.on('close', resolve));
  return { code, out };
}

async function hasScript() {
  const { spawnSync } = await import('node:child_process');
  return process.platform === 'linux' && spawnSync('script', ['--version']).status === 0;
}

// Answers the [y/N] prompt through a real pseudo-terminal (util-linux script).
async function runInTerminal(cli, answer, fx) {
  const { spawn } = await import('node:child_process');
  const command = JSON.stringify(process.execPath) + ' ' + JSON.stringify(cli) + ' uninstall';
  const child = spawn('script', ['-qec', command, '/dev/null'], { env: { ...process.env, PATH: fx.bin + path.delimiter + process.env.PATH, HOME: fx.base, OASIS_CONFIG_DIR: path.join(fx.base, 'cfg') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; if (/\[y\/N\]/.test(out) && !child.answered) { child.answered = true; child.stdin.write(answer + '\r'); } });
  const timer = setTimeout(() => child.kill(), 20000);
  await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  return out;
}

test('oasis uninstall: refuses a source checkout, honours "no", and removes only the package on "yes"', { skip: process.platform === 'win32' }, async () => {
  const { existsSync, readFileSync } = await import('node:fs');
  const { rm } = await import('node:fs/promises');
  const fx = await uninstallFixture();
  try {
    const fromCheckout = await runUninstall(path.join(fx.repo, 'src', 'cli.mjs'), ['--yes'], { bin: fx.bin, home: fx.base });
    assert.notEqual(fromCheckout.code, 0);
    assert.match(fromCheckout.out, /does not look like a global npm installation/);
    assert.equal(existsSync(fx.record), false, 'npm must not run for a source checkout');

    const cli = path.join(fx.installed, 'src', 'cli.mjs');
    const declined = await runUninstall(cli, [], { bin: fx.bin, input: 'n\n', home: fx.base });
    assert.match(declined.out, /Will keep: your projects, OASIS settings, saved sessions, memory, and API keys/);
    // No terminal to ask on: it refuses instead of treating piped input as consent.
    assert.notEqual(declined.code, 0);
    assert.match(declined.out, /needs an interactive terminal/);
    assert.equal(existsSync(fx.record), false, 'npm must not run without a confirmation');
    if (await hasScript()) {
      const said = await runInTerminal(cli, 'n', fx);
      assert.match(said, /Uninstall cancelled\. Nothing was removed\./);
      assert.equal(existsSync(fx.record), false, 'npm must not run when the user says no');
    }

    const approved = await runUninstall(cli, ['--yes'], { bin: fx.bin, home: fx.base });
    assert.equal(approved.code, 0, approved.out);
    assert.deepEqual(JSON.parse(readFileSync(fx.record, 'utf8')), ['uninstall', '--global', '--prefix', path.resolve(fx.prefix), 'oasis-oss']);
    assert.match(approved.out, /OASIS CLI has been uninstalled\. Your projects and user data were kept\./);

    const badArgs = await runUninstall(cli, ['--force'], { bin: fx.bin, home: fx.base });
    assert.notEqual(badArgs.code, 0);
    assert.match(badArgs.out, /Usage: oasis uninstall/);
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});
