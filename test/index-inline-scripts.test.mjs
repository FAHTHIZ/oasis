import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('every inline JavaScript script in index.html parses', () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(([, attributes]) => !/\bsrc\s*=/i.test(attributes))
    .filter(([, attributes]) => {
      const type = attributes.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1]?.toLowerCase();
      return !type || ['text/javascript', 'application/javascript'].includes(type);
    });

  assert.ok(scripts.length > 0, 'expected at least one inline JavaScript script');

  for (const [index, match] of scripts.entries()) {
    assert.doesNotThrow(
      () => new Script(match[2], { filename: 'index.html:inline-script-' + (index + 1) }),
      'inline script ' + (index + 1) + ' must be valid JavaScript'
    );
  }
});
