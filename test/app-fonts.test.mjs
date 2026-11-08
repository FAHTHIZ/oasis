import test from 'node:test';
import assert from 'node:assert/strict';

test('app fonts referenced by app.css are served from app/fonts', async () => {
  const { resolveAppPath } = await import('../src/app-server.mjs');
  const { readFile, stat } = await import('node:fs/promises');
  const pathModule = (await import('node:path')).default;
  const { fileURLToPath } = await import('node:url');
  const root = pathModule.resolve(pathModule.dirname(fileURLToPath(import.meta.url)), '..');
  const css = await readFile(pathModule.join(root, 'app', 'app.css'), 'utf8');
  const fonts = [...css.matchAll(/url\("(fonts\/[^"]+)"\)/g)].map((match) => match[1]);
  assert.ok(fonts.length >= 2);
  for (const font of fonts) {
    const target = resolveAppPath(root, '/app/' + font, new Set());
    assert.ok(target && target.file, font);
    assert.ok((await stat(target.file)).size > 1000, font);
  }
});
