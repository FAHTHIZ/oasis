#!/usr/bin/env node
// Runs the reliability laboratory (src/reliability-lab.mjs) and prints the
// scorecard. Exit 1 when any scenario fails.
//   node scripts/reliability-lab.mjs [--json] [--compare] [scenario-id ...]
// --compare also runs every scenario with live reconciliation off
// (OASIS_AFTER_FAILURE_CHECK=0), to show what it changes.
import { runLab, formatScorecard } from '../src/reliability-lab.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const compare = args.includes('--compare');
const only = args.filter((arg) => !arg.startsWith('--'));
const lab = await runLab({ only: only.length ? only : null });
const baseline = compare ? await runLab({ only: only.length ? only : null, env: { ...process.env, OASIS_AFTER_FAILURE_CHECK: '0' } }) : null;
if (json) process.stdout.write(JSON.stringify(baseline ? { lab, withoutAfterFailureCheck: baseline } : lab, null, 2) + '\n');
else {
  process.stdout.write(formatScorecard(lab) + '\n');
  if (baseline) process.stdout.write('\nWith OASIS_AFTER_FAILURE_CHECK=0:\n\n' + formatScorecard(baseline) + '\n');
}
process.exitCode = lab.passed === lab.total ? 0 : 1;
