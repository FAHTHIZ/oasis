import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// History files describe removed things on purpose; current docs must not.
const HISTORY = new Set(['MISSION-LOG.md']);
const PATH = /`((?:src|app|ide|desktop|scripts|test|assets|docs|bench|evals|plugins|skills)\/[\w./-]+\.\w+)`/g;

test('current docs only name repository files that exist', () => {
  const files = readdirSync(path.join(root, 'docs')).filter((name) => name.endsWith('.md') && !HISTORY.has(name)).map((name) => path.join('docs', name));
  files.push('README.md');
  // Research proposals name OASIS files too; paths inside other projects are
  // written with the project prefix (hermes-agent/...) so they do not match.
  files.push(...readdirSync(path.join(root, 'docs', 'research')).filter((name) => name.endsWith('.md')).map((name) => path.join('docs', 'research', name)));
  const missing = [];
  for (const file of files) {
    const text = readFileSync(path.join(root, file), 'utf8');
    for (const match of text.matchAll(PATH)) if (!existsSync(path.join(root, match[1]))) missing.push(file + ': ' + match[1]);
  }
  assert.deepEqual(missing, []);
});

// Relative links and images in the README, root documents and docs/ (archive
// included) must point at files that exist, and #anchors at real headings.
const slug = (heading) => heading.toLowerCase().replace(/<[^>]+>/g, '').replace(/[`*_~]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-');
const stripCode = (text) => text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
function headingAnchors(file) {
  const anchors = new Set();
  const seen = new Map();
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = slug(match[1]);
    const count = seen.get(base);
    anchors.add(count === undefined ? base : base + '-' + (count + 1));
    seen.set(base, count === undefined ? 0 : count + 1);
  }
  for (const match of text.matchAll(/(?:id|name)="([^"]+)"/g)) anchors.add(match[1]);
  return anchors;
}
function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

test('relative links in the README and docs resolve to files and headings', () => {
  const files = [...readdirSync(root).filter((name) => name.endsWith('.md')).map((name) => path.join(root, name)), ...markdownFiles(path.join(root, 'docs'))];
  const broken = [];
  for (const file of files) {
    const text = stripCode(readFileSync(file, 'utf8'));
    for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)|href="([^"]+)"|src="([^"]+)"/g)) {
      const link = match[1] || match[2] || match[3];
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(link)) continue;
      const [target, anchor] = link.split('#');
      const resolved = target ? path.resolve(path.dirname(file), decodeURIComponent(target)) : file;
      const where = path.relative(root, file) + ': ' + link;
      if (!existsSync(resolved)) broken.push(where);
      else if (anchor && resolved.endsWith('.md') && !headingAnchors(resolved).has(anchor)) broken.push(where + ' (no such heading)');
    }
  }
  assert.deepEqual(broken, []);
});
