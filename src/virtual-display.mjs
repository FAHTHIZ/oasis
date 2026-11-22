// A private X display for computer use (`--computer-use=virtual`, `/computer virtual`,
// OASIS_COMPUTER_DISPLAY=virtual): the agent works on its own screen instead of yours, the way
// Anthropic's computer-use demo and Hermes Agent's sandbox run it. Linux only (Xvfb).
//
// Starts Xvfb on a free display, a window manager when one is installed (so windows get
// focus and title bars), and x11vnc on localhost when installed, so you can watch or take
// over with any VNC viewer. Everything it starts stops with the session.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const WINDOW_MANAGERS = [['openbox', []], ['fluxbox', []], ['xfwm4', []], ['matchbox-window-manager', ['-use_titlebar', 'no']], ['twm', []]];

function onPath(cmd, env) {
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) if (existsSync(path.join(dir, cmd))) return true;
  return false;
}

/** The first display number in [from, to) with no X socket or lock file. */
export function freeDisplayNumber(exists = existsSync, from = 100, to = 200) {
  for (let n = from; n < to; n++) if (!exists('/tmp/.X11-unix/X' + n) && !exists('/tmp/.X' + n + '-lock')) return n;
  throw new Error('No free X display between :' + from + ' and :' + (to - 1) + '.');
}

/** "1280x800" or "1280x800x24" -> { width, height, depth }; defaults to 1280x800x24. */
export function parseScreenSize(value) {
  const match = /^(\d{3,5})x(\d{3,5})(?:x(\d{2}))?$/.exec(String(value || '').trim());
  if (!match) return { width: 1280, height: 800, depth: 24 };
  return { width: Math.min(7680, Number(match[1])), height: Math.min(4320, Number(match[2])), depth: Number(match[3] || 24) };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts the display. Returns { display, size, windowManager, vnc: { port } | null, stop() }.
 * options.spawn and options.exists replace child_process.spawn and fs.existsSync (tests).
 */
export async function startVirtualDisplay(env = process.env, options = {}) {
  if ((options.platform || process.platform) !== 'linux') throw new Error('A virtual display needs Linux with Xvfb. On macOS and Windows computer use drives your own screen.');
  const run = options.spawn || spawn;
  const exists = options.exists || existsSync;
  const has = options.has || ((cmd) => onPath(cmd, env));
  if (!has('Xvfb')) throw new Error('A virtual display needs Xvfb: apt install xvfb (dnf install xorg-x11-server-Xvfb).');
  const size = parseScreenSize(env.OASIS_COMPUTER_VIRTUAL_SIZE);
  const number = freeDisplayNumber(exists);
  const display = ':' + number;
  const children = [];
  const childEnv = { ...env, DISPLAY: display };
  const stop = () => {
    for (const child of children.reverse()) { try { child.kill('SIGTERM'); } catch {} }
    children.length = 0;
  };
  try {
    const xvfb = run('Xvfb', [display, '-screen', '0', size.width + 'x' + size.height + 'x' + size.depth, '-nolisten', 'tcp'], { stdio: 'ignore', env });
    children.push(xvfb);
    let exited = null;
    xvfb.on?.('exit', (code) => { exited = code ?? 'signal'; });
    for (let i = 0; i < 50 && !exists('/tmp/.X11-unix/X' + number); i++) {
      if (exited !== null) throw new Error('Xvfb exited (' + exited + ') before ' + display + ' was ready.');
      await wait(options.pollMs ?? 100);
    }
    if (!exists('/tmp/.X11-unix/X' + number)) throw new Error('Xvfb did not open ' + display + ' within 5 seconds.');
    let windowManager = '';
    for (const [cmd, args] of WINDOW_MANAGERS) {
      if (!has(cmd)) continue;
      children.push(run(cmd, args, { stdio: 'ignore', env: childEnv }));
      windowManager = cmd;
      break;
    }
    let vnc = null;
    if (env.OASIS_COMPUTER_VNC !== '0' && has('x11vnc')) {
      const server = run('x11vnc', ['-display', display, '-localhost', '-nopw', '-forever', '-shared', '-quiet', '-autoport', '5900'], { stdio: ['ignore', 'pipe', 'ignore'], env });
      children.push(server);
      const port = await new Promise((resolve) => {
        let text = '';
        const timer = setTimeout(() => resolve(0), options.vncTimeoutMs ?? 4000);
        server.stdout?.on('data', (chunk) => {
          text += chunk;
          const match = /PORT=(\d+)/.exec(text);
          if (match) { clearTimeout(timer); resolve(Number(match[1])); }
        });
        server.on?.('exit', () => { clearTimeout(timer); resolve(0); });
      });
      if (port) vnc = { port, address: 'localhost:' + port };
    }
    return { display, size, windowManager, vnc, env: childEnv, stop };
  } catch (error) {
    stop();
    throw error;
  }
}

/** Starts a desktop app on the display without a shell. Returns its pid. */
export function launchOnDisplay(app, args, env, options = {}) {
  const run = options.spawn || spawn;
  const platform = options.platform || process.platform;
  const command = platform === 'darwin' ? 'open' : app;
  const argv = platform === 'darwin' ? ['-a', app, ...(args.length ? ['--args', ...args] : [])] : args;
  const child = run(command, argv, { stdio: 'ignore', env, detached: platform !== 'win32', windowsHide: false });
  child.on?.('error', () => {});
  child.unref?.();
  return child;
}
