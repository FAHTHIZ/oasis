// `oasis bg logs --follow` re-read the whole log every 700 ms. It now reads only
// complete lines appended since the last poll.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCompleteLinesFrom } from '../src/cli-sessions.mjs';

test('reads only new complete lines and keeps multibyte text intact', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-bg-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'run.log');
  assert.deepEqual(await readCompleteLinesFrom(file, 0), { text: '', offset: 0 });

  await writeFile(file, '{"a":"ঢাকা"}\n{"b":"partial');
  const first = await readCompleteLinesFrom(file, 0);
  assert.equal(first.text, '{"a":"ঢাকা"}\n');
  assert.equal(first.offset, Buffer.byteLength(first.text));

  assert.deepEqual(await readCompleteLinesFrom(file, first.offset), { text: '', offset: first.offset });

  await appendFile(file, ' done"}\n{"c":1}\n');
  const second = await readCompleteLinesFrom(file, first.offset);
  assert.equal(second.text, '{"b":"partial done"}\n{"c":1}\n');

  await writeFile(file, '{"new":true}\n');
  assert.equal((await readCompleteLinesFrom(file, second.offset)).text, '{"new":true}\n', 'a truncated log is read from the start');
});
