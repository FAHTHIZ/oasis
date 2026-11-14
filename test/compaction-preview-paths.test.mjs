// Regression: /compact's preview listed "oasis/followups.json" (from Oasis's
// own follow-up reminder, with the dot lost) and missed the bare "math.mjs"
// the conversation was about.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompactionPreview } from '../src/context.mjs';

test('compaction preview paths come from the conversation, keep dot-folders, and include bare source files', () => {
  const session = { messages: [
    { role: 'system', content: 'system prompt mentioning src/system-only.ts' },
    { role: 'user', content: '<system-reminder>\nOpen follow-ups recorded in earlier sessions for this project (from .oasis/followups.json).\n</system-reminder>\nhello, look at math.mjs' },
    { role: 'assistant', content: 'First answer about math.mjs. Also see src/lib/util.ts, .github/workflows/ci.yml, e.g. v1.2, node v20.1.0, https://example.com/page.html and foo@1.2.3.' }
  ] };
  const preview = createCompactionPreview(session);
  assert.deepEqual(preview.recentPaths, ['math.mjs', 'src/lib/util.ts', '.github/workflows/ci.yml']);
});
