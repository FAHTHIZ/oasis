import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runEvalCommand } from '../src/eval.mjs';

// Seen live: OpenCode takes its project directory from $PWD, so an inherited
// PWD made it edit the folder the benchmark was started from instead of the
// task workspace, and every trial failed with "no changes".
test('external agents run with PWD set to the task workspace', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-pwd-agent-'));
  const decoy = await mkdtemp(path.join(os.tmpdir(), 'oasis-pwd-decoy-'));
  try {
    const bin = path.join(dir, 'fake-opencode');
    await writeFile(bin, '#!/usr/bin/env node\n' +
      "const fs = require('fs'); const path = require('path');\n" +
      "if (process.argv[2] !== 'run') { console.log('1.0.0'); process.exit(0); }\n" +
      "const root = process.env.PWD; fs.mkdirSync(path.join(root, 'src'), { recursive: true });\n" +
      "fs.writeFileSync(path.join(root, 'src', 'lib.mjs'), \"import path from 'node:path';\\nexport function resolveRelative(root, value) { if (path.isAbsolute(value)) throw new Error('Path escapes root'); const out = path.resolve(root, value); const rel = path.relative(root, out); if (rel.startsWith('..')) throw new Error('Path escapes root'); return out; }\\n\");\n" +
      "console.log(JSON.stringify({ type: 'text', part: { type: 'text', text: 'done' } }));\n");
    await chmod(bin, 0o755);
    const lines = [];
    const result = await runEvalCommand(['--opencode', '--task', 'safe-relative-path', '--trials', '1', '--timeout-seconds', '60'], {
      autoApprove: true,
      env: { ...process.env, OASIS_OPENCODE_BIN: bin, PWD: decoy },
      output: { write: (text) => { lines.push(String(text)); return true; } },
      resultsDir: dir
    });
    assert.equal(result.results[0].passed, true, lines.join('') + JSON.stringify(result.results[0].verification));
    await assert.rejects(access(path.join(decoy, 'src', 'lib.mjs')));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(decoy, { recursive: true, force: true });
  }
});
