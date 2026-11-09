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

if (!process.env.OASIS_NO_COMPILE_CACHE && typeof module.enableCompileCache === 'function') {
  try { module.enableCompileCache(); } catch {}
}
globalThis.__OASIS_CLI_ENTRY = true;
await import('./cli.mjs');
