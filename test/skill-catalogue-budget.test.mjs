import test from 'node:test';
import assert from 'node:assert/strict';
import { fitSkillCatalogue } from '../src/tools.mjs';

test('skill catalogue keeps whole lines and counts the skills it drops', () => {
  const lines = Array.from({ length: 10 }, (_, i) => '- skill' + i + ': ' + 'x'.repeat(40));
  assert.equal(fitSkillCatalogue(lines, 10000), lines.join('\n'));
  const fitted = fitSkillCatalogue(lines, 200);
  assert.ok(fitted.length <= 200, String(fitted.length));
  const out = fitted.split('\n');
  for (const line of out.slice(0, -1)) assert.ok(lines.includes(line), 'no line is cut: ' + line);
  const kept = out.length - 1;
  assert.equal(out.at(-1), '- (' + (10 - kept) + ' more skills not listed; call list_skills to see them all)');
  assert.ok(kept >= 1);
  // The note is reserved while later skills remain, so the last fitting line is never cut.
  const long = ['- a: ' + 'y'.repeat(100), '- b: ' + 'y'.repeat(100), '- c: ' + 'y'.repeat(100)];
  assert.equal(fitSkillCatalogue(long, 280), long[0] + '\n' + long[1] + '\n- (1 more skill not listed; call list_skills to see them all)');
  assert.equal(fitSkillCatalogue([], 100), '');
});
