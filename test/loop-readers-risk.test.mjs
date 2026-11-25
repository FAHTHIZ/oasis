import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeShellLine, shellAnalyzerReady } from '../src/shell-risk.mjs';

// Seen live: `for f in *.js; do wc -l "$f"; done` asked as "HIGH RISK:
// could not be parsed reliably". A loop of plain readers cannot do harm.
test('a globbed loop of readers is normal risk; one that writes or deletes is not', async () => {
  if (shellAnalyzerReady) await shellAnalyzerReady();
  for (const line of ['for f in *.js; do wc -l "$f"; done', 'for f in *; do grep -c x "$f" | head -1; done', 'for f in *.js; do echo "$f" 2>&1; done']) {
    assert.deepEqual(analyzeShellLine(line), {}, line);
  }
  for (const line of ['for f in *.tmp; do rm "$f"; done', 'for f in *.js; do cat "$f" > out.txt; done', 'for f in *; do $f; done', 'for f in *; do echo $(rm $f); done', 'for f in *; do rg --pre sh x "$f"; done', 'for d in /*; do rm -rf "$d"; done']) {
    assert.ok(analyzeShellLine(line).highRisk || analyzeShellLine(line).blocked, line);
  }
});
