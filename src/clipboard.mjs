// Copy text to the system clipboard with whatever the platform provides.
// Returns { ok, method }; callers fall back to the OSC 52 terminal escape.
import { spawn } from 'node:child_process';
import { onPathSync } from './clipboard-path.mjs';

export function clipboardCandidates(platform = process.platform, env = process.env) {
  if (platform === 'darwin') return [['pbcopy', []]];
  if (platform === 'win32') return [['clip', []]];
  const list = [];
  if (env.WAYLAND_DISPLAY) list.push(['wl-copy', []]);
  list.push(['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']], ['wl-copy', []], ['termux-clipboard-set', []]);
  if (env.WSL_DISTRO_NAME) list.unshift(['clip.exe', []]);
  return list.filter((item, index) => list.findIndex((other) => other[0] === item[0]) === index);
}

function pipeTo(command, args, text, env) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], env, windowsHide: true }); } catch { resolve(false); return; }
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 3000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    // xclip/xsel keep running to serve the selection; a successful write is enough.
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
    child.stdin.on('error', () => {});
    child.stdin.end(text);
    if (command === 'xclip' || command === 'xsel') child.unref();
  });
}

export async function copyToClipboard(text, { env = process.env, platform = process.platform } = {}) {
  if (env.OASIS_CLIPBOARD === 'osc52') return { ok: false };
  for (const [command, args] of clipboardCandidates(platform, env)) {
    if (!onPathSync(command, env, platform)) continue;
    if (await pipeTo(command, args, text, env)) return { ok: true, method: command };
  }
  return { ok: false };
}
