import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { endChildInput } from '../src/node-process.mjs';

// Regression: auto-commit piped paths to `git check-ignore --stdin`; when git
// exited before reading (a failing hook in CI), the EPIPE on stdin was an
// uncaught exception that failed the whole test run.
test('input to a child that exits without reading does not raise an uncaught EPIPE', async () => {
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  try {
    for (let i = 0; i < 5; i += 1) {
      const status = await new Promise((resolve) => {
        const child = execFile(process.execPath, ['-e', 'process.exit(3)'], (error) => resolve(error ? error.code : 0));
        endChildInput(child, 'x'.repeat(4 * 1024 * 1024));
      });
      assert.equal(status, 3);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  assert.deepEqual(uncaught.map((error) => error.code), []);
});

test('a child that reads its input still receives all of it', async () => {
  const out = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ['-e', "let n=0;process.stdin.on('data',c=>n+=c.length).on('end',()=>console.log(n))"], (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
    endChildInput(child, 'y'.repeat(100000));
  });
  assert.equal(out, '100000');
});
