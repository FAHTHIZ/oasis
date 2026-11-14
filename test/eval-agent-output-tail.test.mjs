import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runEvalCommand, agentOutputTail } from '../src/eval.mjs';

// Seen live: an Aider trial failed with no clue why, because the harness kept
// none of what the agent printed. A failed trial now keeps the end of it, with
// the credentials it was given removed.
test('a failed external-agent trial keeps a redacted tail of the agent output', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-tail-agent-'));
  const key = 'freellmapi-' + 'Zq7'.repeat(12);
  try {
    const bin = path.join(dir, 'fake-aider');
    await writeFile(bin, '#!/usr/bin/env node\n' +
      "if (process.argv.includes('--version')) { console.log('aider 0.0.1'); process.exit(0); }\n" +
      "console.log('x'.repeat(6000));\n" +
      "console.log('Using key ' + process.env.OPENAI_API_KEY + ' and api_key=Qw8rT2zLp9Xv4Nk7');\n" +
      "console.log('Model replied without an edit block; no files changed.');\n");
    await chmod(bin, 0o755);
    const result = await runEvalCommand(['--aider', '--task', 'safe-relative-path', '--trials', '1', '--timeout-seconds', '60'], {
      autoApprove: true,
      env: { ...process.env, OASIS_AIDER_BIN: bin, OPENAI_API_KEY: key },
      output: { write: () => true },
      resultsDir: dir
    });
    const row = result.results[0];
    assert.equal(row.passed, false);
    assert.match(row.agentOutputTail, /no files changed/);
    assert.ok(row.agentOutputTail.length <= 3000);
    assert.doesNotMatch(row.agentOutputTail, /Zq7Zq7/);
    assert.doesNotMatch(row.agentOutputTail, /Qw8rT2zLp9Xv4Nk7/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the output tail leaves no fragment of a secret that straddles the cut', () => {
  const secret = 'S3cr3tValue-' + 'a1'.repeat(20);
  const text = 'y'.repeat(5000) + secret + 'z'.repeat(3000 - 10);
  const tail = agentOutputTail(text, { PROVIDER_TOKEN: secret });
  assert.doesNotMatch(tail, /a1a1a1/);
});
