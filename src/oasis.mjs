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
