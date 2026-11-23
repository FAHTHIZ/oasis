#!/usr/bin/env node
// Fails when a pushed commit credits an AI tool in a trailer or footer
// ("Co-authored-by: <assistant> <noreply@...>", "Generated with ..."). Uses
// the same detector OASIS applies to the commits it writes itself
// (src/commit-attribution.mjs). Sign-offs are left alone: Dependabot signs
// its own commits.
//
// Usage: node .github/scripts/check-commit-attribution.mjs <before> <after>
// A missing or all-zero <before> (a new branch) checks <after> alone.
import { execFileSync } from 'node:child_process';
import { isAiCredit } from '../../src/commit-attribution.mjs';

export function attributionProblems(log) {
  const problems = [];
  for (const record of String(log || '').split('\u0001')) {
    const [sha, body = ''] = record.replace(/^\s+/, '').split('\u0000');
    if (!sha) continue;
    for (const line of body.split(/\r?\n/)) {
      if (isAiCredit(line) && !/^\s*signed-off-by\s*:/i.test(line)) problems.push(sha.slice(0, 12) + ': ' + line.trim());
    }
  }
  return problems;
}

function main([before = '', after = 'HEAD']) {
  const range = /^0*$/.test(before) ? ['-1', after] : [before + '..' + after];
  const log = execFileSync('git', ['log', '--format=%H%x00%B%x01', ...range], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const problems = attributionProblems(log);
  if (!problems.length) { console.log('No AI attribution trailers in ' + range.join(' ') + '.'); return 0; }
  console.error('Commits credit an AI tool; reword them without the trailer or footer:\n' + problems.map((line) => '  ' + line).join('\n'));
  return 1;
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) process.exitCode = main(process.argv.slice(2));
