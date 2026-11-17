import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the animated README art in assets/readme/ matches its generator', () => {
  const run = spawnSync(process.execPath, ['scripts/readme-art.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('README art respects reduced motion and stays self-contained', async () => {
  for (const name of ['hero.svg', 'architecture.svg', 'pipeline-dark.svg', 'pipeline-light.svg', 'divider-dark.svg', 'icon-verified-dark.svg']) {
    const svg = await readFile(path.join(root, 'assets/readme', name), 'utf8');
    assert.match(svg, /^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, name);
    assert.ok(!/<script|href="https?:/i.test(svg), `${name} must not load scripts or remote resources`);
    if (svg.includes('@keyframes')) assert.ok(svg.includes('prefers-reduced-motion'), `${name} must honour prefers-reduced-motion`);
  }
});
