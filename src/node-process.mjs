// Running OASIS's own Node.js code in a child process.
//
// Inside the desktop app, process.execPath is the Electron (OASIS) binary, not
// node. Started plainly it would open another app window; with
// ELECTRON_RUN_AS_NODE=1 it behaves exactly like node. The variable is added
// only to children that run OASIS's own scripts, never to user shells or
// tools (it would break other Electron apps such as the VS Code CLI).
export function nodeChildEnv(env = process.env, { versions = process.versions } = {}) {
  if (!versions || !versions.electron) return env;
  return { ...env, ELECTRON_RUN_AS_NODE: '1' };
}
