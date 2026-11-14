import test from 'node:test';
import assert from 'node:assert/strict';
import { askUserQuestion } from '../src/ask-user.mjs';

test('a long typed answer and a long question reach their destination whole', async () => {
  const answer = 'Spec:\n' + 'line of detail\n'.repeat(500);
  const question = 'Which of these layouts should the dashboard use, given ' + 'context '.repeat(100) + '?';
  let shown;
  const result = await askUserQuestion({}, { question, options: [{ label: 'A grid layout with a sidebar for filters', description: 'd'.repeat(500) }, 'B'] }, {
    askUser: async (normalized) => { shown = normalized; return answer; }
  });
  assert.equal(shown.question, question);
  assert.equal(shown.options[0].description.length, 500);
  assert.equal(result.answer, answer);
});
