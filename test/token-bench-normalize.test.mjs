import test from 'node:test';
import assert from 'node:assert/strict';
import { hostIndependent, CANONICAL_ROOT } from '../bench/tokens/normalize.mjs';

// CI failed the token gate by 9 tokens on code that passed locally: the
// prompt carried the runner's kernel release, Node patch version, date and
// temp path, and tool results carried random ids and timings.
const sample = (root, kernel, node, date, scratch, uuid, ms) => JSON.stringify({ messages: [
  { role: 'system', content: 'Platform: linux ' + kernel + ' (x64), Node ' + node + "\nToday's date: " + date + '\nWorkspace: ' + root + '/ws-a\nuse .oasis/scratch/' + scratch + '/ for probes' },
  { role: 'tool', content: JSON.stringify({ stdout: '# duration_ms ' + ms + '\n  duration_ms: ' + ms, stdoutLogPath: '.oasis/command-logs/' + uuid + '.stdout.log' }) }
] });

test('host facts, random ids and timings normalize to one text on every machine', () => {
  const local = hostIndependent(sample('/tmp/oasis-token-bench', '6.1.102', 'v22.20.0', '2026-11-14', '92ee42a8', 'e89f7e61-73b6-4b2f-89e5-9041f89c053b', '50.549846'), '/tmp/oasis-token-bench');
  const ci = hostIndependent(sample('/home/runner/work/_temp/oasis-token-bench', '6.11.0-1018-azure', 'v22.21.1', '2026-11-15', '2ff883d4', '6ad74c43-c03a-4f65-80ba-214be4e96fdf', '372.168177'), '/home/runner/work/_temp/oasis-token-bench');
  assert.equal(local, ci);
  assert.match(local, new RegExp(CANONICAL_ROOT + '/ws-a'));
  assert.equal(JSON.parse(local).messages.length, 2, 'still valid JSON');
});

test('ordinary content is left alone', () => {
  const text = JSON.stringify({ content: 'export function f() { return 42; } // 2.5 seconds' });
  assert.equal(hostIndependent(text), text);
});
