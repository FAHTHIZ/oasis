// Launches a packaged OASIS desktop app against a scratch profile and project
// and checks that its workspace server answers. Used by CI on every platform.
//
//   node desktop/scripts/smoke.mjs [path to the unpacked app executable]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const release = path.join(root, 'release');

export function findPackagedApp(dir = release, platform = process.platform) {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir)) {
    const folder = path.join(dir, entry);
    if (platform === 'linux' && /^linux(-[a-z0-9]+)?-unpacked$/.test(entry)) return path.join(folder, 'oasis-desktop');
    if (platform === 'win32' && /^win(-[a-z0-9]+)?-unpacked$/.test(entry)) return path.join(folder, 'OASIS.exe');
    if (platform === 'darwin' && /^mac(-[a-z0-9]+)?$/.test(entry)) return path.join(folder, 'OASIS.app', 'Contents', 'MacOS', 'OASIS');
  }
  return null;
}

async function main() {
  const executable = process.argv[2] || findPackagedApp();
  if (!executable || !existsSync(executable)) throw new Error('No packaged app found in ' + release + '. Build one first.');
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'oasis-desktop-smoke-'));
  const userData = path.join(scratch, 'profile');
  const project = path.join(scratch, 'project');
  mkdirSync(userData, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, 'README.md'), '# smoke\n');
  // A saved folder skips the first-run folder picker.
  writeFileSync(path.join(userData, 'desktop-state.json'), JSON.stringify({ workspace: project }));
  const port = 47000 + Math.floor(Math.random() * 500);
  const env = { ...process.env, OASIS_DESKTOP_USER_DATA: userData, OASIS_DESKTOP_PORT: String(port), OASIS_NO_UPDATE_CHECK: '1', OASIS_CONFIG_DIR: path.join(scratch, 'config') };
  const args = process.platform === 'linux' ? ['--no-sandbox'] : [];
  // Its own process group, so stopping it also stops Electron's helpers and
  // anything a launcher (AppImage runtime, wrapper script) started.
  const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  const deadline = Date.now() + 90_000;
  let ok = false;
  let detail = '';
  while (Date.now() < deadline && !exited) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/app/');
      const body = await response.text();
      if (response.ok && /OASIS/.test(body)) { ok = true; break; }
      detail = 'HTTP ' + response.status;
    } catch (error) { detail = String(error && error.cause && error.cause.code || error.message); }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const stop = (signal) => {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(-child.pid, signal); } catch { /* already gone */ } }
  };
  stop('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 2000));
  stop('SIGKILL');
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows may still hold files */ }
  if (!ok) {
    console.error(log.slice(-4000));
    throw new Error('The desktop app did not serve its workspace' + (exited ? ' (it exited with ' + JSON.stringify(exited) + ')' : '') + '. Last result: ' + detail);
  }
  console.log('Desktop app started and served its workspace on port ' + port + ': ' + executable);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error && error.message || error); process.exit(1); });
}
