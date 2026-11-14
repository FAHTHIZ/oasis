// Protocol servers (ACP, the Codex app server, the Telegram gateway) save the
// session after each turn. A failed save (disk full, a session over the size
// cap) must reach their log instead of losing the session without a word.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

for (const file of ['acp.mjs', 'codex-app-server.mjs', 'gateway-telegram.mjs']) {
  test(file + ' logs a failed session save', async () => {
    const source = await readFile(new URL('../src/' + file, import.meta.url), 'utf8');
    assert.equal(/await saveSession\([^;]*\); \} catch \{\}/.test(source), false);
    assert.match(source, /could not save the session/);
  });
}

for (const file of ['cli.mjs', 'web.mjs']) {
  test(file + ' reports a failed save after idle compaction', async () => {
    const source = await readFile(new URL('../src/' + file, import.meta.url), 'utf8');
    assert.equal(/saveSession\([^;]*\)\.catch\(\(\) => \{\}\)/.test(source), false);
    assert.match(source, /could not save the compacted session/i);
  });
}
