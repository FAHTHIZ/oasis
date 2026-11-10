#!/usr/bin/env node
// `npm test`: runs the suite with a private temporary directory and removes
// it afterwards. Many tests create scratch projects under os.tmpdir(); without
// this, every full run left a few hundred folders behind (about 1 GB, mostly
// heap snapshots from the /heapdump test).
//
//   npm test                         # every test/*.test.mjs
//   npm test -- test/web.test.mjs    # selected files (any node --test flags work)
//
// Set OASIS_KEEP_TEST_TMP=1 to keep the folder for debugging; its path is printed.
// HOME (and the Windows profile folders) point inside it too; see below.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const files = args.some((arg) => !arg.startsWith('-')) ? [] : ['test/*.test.mjs'];
const scratch = mkdtempSync(path.join(os.tmpdir(), 'oasis-test-run-'));
const keep = /^(?:1|true|yes)$/i.test(process.env.OASIS_KEEP_TEST_TMP || '');

const cleanup = () => {
  if (keep) { process.stderr.write('Test scratch folder kept: ' + scratch + '\n'); return; }
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
};

// A private home as well: tests must not read or write the developer's real
// ~/.config/oasis (a refreshed model catalog there changed expected context
// windows, and runs left backup folders behind). OASIS_TEST_REAL_HOME=1 opts out.
const home = path.join(scratch, 'home');
mkdirSync(home, { recursive: true });
const realHome = /^(?:1|true|yes)$/i.test(process.env.OASIS_TEST_REAL_HOME || '');
const isolated = realHome ? {} : { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') };
// Git still needs a fallback identity for tests that commit. A scratch
// ~/.gitconfig (not GIT_AUTHOR_* variables, which would override the
// identity a test sets inside its own repository) keeps the developer's.
if (!realHome) {
  const read = (key) => { try { return execFileSync('git', ['config', '--get', key], { encoding: 'utf8' }).trim(); } catch { return ''; } };
  const name = read('user.name') || 'OASIS Tests';
  const email = read('user.email') || 'tests@oasis.invalid';
  writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = ' + name.replace(/[\r\n]/g, ' ') + '\n\temail = ' + email.replace(/[\r\n]/g, '') + '\n');
}
// Browser tests look for Playwright's Chrome under the home folder; keep
// finding the developer's copy rather than skipping.
if (!realHome && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const realCache = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
    : process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')
      : path.join(os.homedir(), '.cache', 'ms-playwright');
  if (existsSync(realCache)) isolated.PLAYWRIGHT_BROWSERS_PATH = realCache;
}
const child = spawn(process.execPath, ['--test', ...args, ...files], {
  stdio: 'inherit',
  env: { ...process.env, ...isolated, TMPDIR: scratch, TMP: scratch, TEMP: scratch }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  cleanup();
  process.exit(code === null ? (signal ? 1 : 0) : code);
});
