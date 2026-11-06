import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Packages that are only needed for specific tools load on first use, so every
// OASIS start (CLI, headless, web) does not pay for them.
const DEFERRED = ['linkedom', 'defuddle', 'turndown', 'vscode-jsonrpc', 'gpt-tokenizer', 'sharp', 'lowlight', '@opentelemetry/sdk-trace-base', 'ajv'];

test('loading the CLI module graph does not import tool-specific heavy packages', () => {
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const script = `
    import { registerHooks } from 'node:module';
    const seen = new Set();
    registerHooks({ load(url, context, next) { const m = /node_modules\\/((?:@[^/]+\\/)?[^/]+)/.exec(url); if (m) seen.add(m[1]); return next(url, context); } });
    process.argv = [process.argv[0], ${JSON.stringify(cli)}, '--version'];
    process.on('exit', () => process.stderr.write('LOADED ' + JSON.stringify([...seen])));
    await import(${JSON.stringify(cli)});
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, OASIS_MODEL_CATALOG_REFRESH: '0' } });
  const match = /LOADED (\[.*\])/.exec(run.stderr || '');
  assert.ok(match, 'no module report: ' + String(run.stderr).slice(-400));
  const loaded = JSON.parse(match[1]);
  assert.ok(loaded.length > 0, 'hook saw packages');
  for (const name of DEFERRED) assert.ok(!loaded.includes(name), name + ' is imported at startup');
});
