#!/usr/bin/env node
// npm entry point. Node 22's on-disk compile cache must be enabled before the
// CLI's module graph loads, so it cannot live in cli.mjs (static imports are
// hoisted). Measured: `oasis --version` 156 ms -> 117 ms on a warm cache.
// OASIS_NO_COMPILE_CACHE=1 or NODE_DISABLE_COMPILE_CACHE=1 turn it off.
import module from 'node:module';

if (!process.env.OASIS_NO_COMPILE_CACHE && typeof module.enableCompileCache === 'function') {
  try { module.enableCompileCache(); } catch {}
}
await import('./cli.mjs');
