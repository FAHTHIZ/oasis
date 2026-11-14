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

// Give a child its stdin and close it without letting a child that exits
// early (a failing git hook, a missing command) crash OASIS: writing to a
// closed pipe raises EPIPE on the stream, and an unhandled stream error is an
// uncaught exception. The child's exit status still reports the failure.
export function endChildInput(child, input) {
  if (!child || !child.stdin) return;
  child.stdin.on('error', () => {});
  if (input !== undefined) child.stdin.end(input);
}
