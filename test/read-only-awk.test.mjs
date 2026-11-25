import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readOnlyShellLine } from '../src/read-only-commands.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'oasis-awk-'));
writeFileSync(path.join(root, 's.csv'), 'a,b\n1,2\n');
writeFileSync(path.join(root, '.env'), 'KEY=1\n');

// Seen live: a subagent's `awk -F, '{print $2}' sales.csv | sort | uniq`
// stopped the run for an approval although it only reads.
test('an awk program that only reads and prints runs without asking', () => {
  for (const line of [
    "awk -F, '{print $2}' s.csv | sort | uniq",
    "awk -F, 'NR>1 && $2 > 1 {n++} END{print n}' s.csv",
    "awk -v want=2 -F',' '$2 == want {print $1}' s.csv",
    "grep '$HOME' s.csv",
    "grep '<div>' s.csv"
  ]) assert.equal(readOnlyShellLine(line, { root }), true, line);
});

test('awk that writes, runs programs, reads the environment or leaves the folder still asks', () => {
  for (const line of [
    `awk '{print > "out"}' s.csv`,
    `awk '{printf "%s", $1 >> "out"}' s.csv`,
    `awk 'BEGIN{system("rm -rf x")}'`,
    `awk '{print | "sh"}' s.csv`,
    `awk 'BEGIN{while (("ls" | getline l) > 0) print l}'`,
    `awk 'BEGIN{print ENVIRON["KEY"]}'`,
    `awk '@include "x"' s.csv`,
    `awk 'BEGIN{print "x" > "/dev/stderr"}'`,
    'awk -f prog.awk s.csv',
    "gawk -i inplace '{print}' s.csv",
    "awk -o out '{print}' s.csv",
    "awk '{print}' .env",
    "awk '{print}' /etc/passwd",
    'grep "$HOME" s.csv',
    "cat 's.csv",
    "echo 'a' > f"
  ]) assert.equal(readOnlyShellLine(line, { root }), false, line);
});
