// Codex CLI's two leading developer messages became two system messages that
// Qwen3.5's chat template rejects; through LiteLLM's streamed Responses
// translation that surfaced as an empty 200 reply and a 0-token Codex "fail".
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLeadingSystemMessages } from '../bench/translate/ovh-hop.mjs';

test('the benchmark OVH hop merges a leading run of system messages into one', () => {
  const merged = mergeLeadingSystemMessages([
    { role: 'system', content: 'Be brief.' },
    { role: 'system', content: [{ type: 'text', text: 'Use ' }, { type: 'text', text: 'English.' }] },
    { role: 'user', content: 'hi' },
    { role: 'system', content: 'later note' }
  ]);
  assert.deepEqual(merged, [
    { role: 'system', content: 'Be brief.\n\nUse English.' },
    { role: 'user', content: 'hi' },
    { role: 'system', content: 'later note' }
  ]);
  const single = [{ role: 'system', content: 'x' }, { role: 'user', content: 'y' }];
  assert.equal(mergeLeadingSystemMessages(single), single);
  assert.equal(mergeLeadingSystemMessages(undefined), undefined);
});
