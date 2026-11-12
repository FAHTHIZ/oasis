// Domain-filtered sandbox on Anthropic's sandbox-runtime (srt, Apache-2.0),
// the sandbox Claude Code uses: bubblewrap + seccomp on Linux, Seatbelt on
// macOS, with an in-process HTTP/SOCKS proxy that allows only the configured
// domains. Selected when settings.sandbox.allowedDomains is set.
//
// The proxy lives in this process and keeps the event loop alive, so it is
// reference-counted: started for the first sandboxed command and reset when
// the last one (foreground or background) exits.
import { shellQuote } from './ssh-backend.mjs';
import { protectedWritePaths } from './sandbox.mjs';
export { domainList } from './sandbox.mjs';
import { resolveRipgrep } from './ripgrep.mjs';

let loaded = null;
let activeKey = '';
let active = 0;
let starting = null;
let resetTimer = null;

async function manager() {
  loaded ||= import('@anthropic-ai/sandbox-runtime').then((module) => module.SandboxManager);
  return loaded;
}

/** srt policy for an OASIS sandbox description. */
export function srtConfig(sandbox) {
  const guarded = protectedWritePaths(sandbox.protectedRoots || []);
  const rg = resolveRipgrep(process.env);
  const block = sandbox.readBlock || null;
  const allowRead = [...(sandbox.reopenedPaths || []).map((item) => item.path), ...(block ? [...(sandbox.writable || []), ...block.reopen.map((item) => item.path)] : [])];
  return {
    network: { allowedDomains: sandbox.allowedDomains || [], deniedDomains: sandbox.deniedDomains || [] },
    filesystem: {
      denyRead: [...(block ? block.hidden.map((item) => item.path) : []), ...(sandbox.maskedPaths || []).map((item) => item.path)],
      ...(allowRead.length ? { allowRead: [...new Set(allowRead)] } : {}),
      allowWrite: [...(sandbox.writable || []), ...(block ? block.reopen.filter((item) => item.writable).map((item) => item.path) : [])],
      denyWrite: [...guarded.existing, ...(sandbox.readOnlyPaths || [])].map((item) => item.path)
    },
    ...(rg ? { ripgrep: { command: rg.path } } : {})
  };
}

async function acquire(sandbox) {
  const SandboxManager = await manager();
  const config = srtConfig(sandbox);
  const key = JSON.stringify(config);
  clearTimeout(resetTimer);
  while (starting) await starting;
  if (key !== activeKey) {
    starting = (async () => {
      if (activeKey) await SandboxManager.reset();
      activeKey = '';
      await SandboxManager.initialize(config);
      activeKey = key;
    })();
    try { await starting; } finally { starting = null; }
  }
  active++;
  return SandboxManager;
}

function release() {
  active = Math.max(0, active - 1);
  if (active) return;
  clearTimeout(resetTimer);
  // A short grace period lets back-to-back commands reuse the proxy.
  resetTimer = setTimeout(async () => {
    if (active || !activeKey) return;
    activeKey = '';
    try { await (await manager()).reset(); } catch {}
  }, 200);
  resetTimer.unref?.();
}

/** Launch description ({ command, args, release }) for running argv inside srt. */
export async function srtLaunch(command, args, sandbox, cwd) {
  const SandboxManager = await acquire(sandbox);
  let released = false;
  const done = () => { if (!released) { released = true; release(); } };
  try {
    const line = [command, ...args].map(shellQuote).join(' ');
    const { argv } = await SandboxManager.wrapWithSandboxArgv(line, undefined, undefined, undefined, cwd);
    return { command: argv[0], args: argv.slice(1), release: done };
  } catch (error) {
    done();
    throw error;
  }
}

/** Test hook: whether the proxy is running and how many commands hold it. */
export function sandboxRuntimeState() {
  return { running: Boolean(activeKey), active };
}
