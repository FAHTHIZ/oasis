#!/usr/bin/env node
// npm entry point. Node 22's on-disk compile cache must be enabled before the
// CLI's module graph loads, so it cannot live in cli.mjs (static imports are
// hoisted). Measured: `oasis --version` 156 ms -> 117 ms on a warm cache.
// OASIS_NO_COMPILE_CACHE=1 or NODE_DISABLE_COMPILE_CACHE=1 turn it off.
import module from 'node:module';

// `oasis --version` alone answers without loading the agent's module graph
// (about 250 ms -> 60 ms on a cold 2-CPU machine). Same output as cli.mjs.
const argv = process.argv.slice(2);
if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
  const { oasisVersion } = await import('./version.mjs');
  process.stdout.write('OASIS ' + oasisVersion() + '\n');
  process.exit(0);
}
// Bare `oasis --help` / `-h` / `help` (and `help all`) likewise: only the help
// text loads (about 325 ms and 113 MB peak -> the --version cost). Same output
// as cli.mjs; OASIS_FULL_HELP_PATH=1 forces the full path (used by the test).
const helpWord = argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help';
const helpAll = argv.length === 2 && (argv[1] === 'all' || argv[1] === '--all');
if (helpWord && (argv.length === 1 || helpAll) && !process.env.OASIS_FULL_HELP_PATH) {
  const { printQuickHelp, printHelp } = await import('./cli-help.mjs');
  if (helpAll) printHelp(); else printQuickHelp();
  // Pipes are asynchronous on Windows: let the help text drain before exiting.
  await new Promise((resolve) => process.stdout.write('', resolve));
  process.exit(0);
}

// npm only warns about "engines", so an older Node.js used to start OASIS and
// fail later in odd places (the terminal renderer, OpenTelemetry, require() of
// ES modules). Stop with the fix instead. `doctor` and `uninstall` still run so
// the user can see the full report or remove the package;
// OASIS_ALLOW_UNSUPPORTED_NODE=1 skips the check.
{
  const { isNodeVersionSupported, MIN_NODE_VERSION } = await import('./config.mjs');
  if (!isNodeVersionSupported() && !/^(?:1|true|yes)$/i.test(process.env.OASIS_ALLOW_UNSUPPORTED_NODE || '') && !['doctor', 'uninstall'].includes(argv[0])) {
    process.stderr.write('OASIS needs Node.js ' + MIN_NODE_VERSION.replace(/\.0$/, '') + ' or newer; this is Node.js v' + process.versions.node + '.\n'
      + '  Install a current Node.js LTS from https://nodejs.org/en/download (or with your version manager), then run oasis again.\n'
      + '  oasis doctor shows the full report. OASIS_ALLOW_UNSUPPORTED_NODE=1 starts anyway (unsupported).\n');
    process.exit(1);
  }
}

if (!process.env.OASIS_NO_COMPILE_CACHE && typeof module.enableCompileCache === 'function') {
  try { module.enableCompileCache(); } catch {}
}
// `oasis doctor | head` closes the pipe early. Like other Unix tools, stop
// quietly instead of printing an unhandled EPIPE stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error && error.code === 'EPIPE') process.exit(0);
    throw error;
  });
}
globalThis.__OASIS_CLI_ENTRY = true;
await import('./cli.mjs');
