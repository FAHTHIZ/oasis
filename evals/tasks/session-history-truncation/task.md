Fix session persistence for long conversation histories.

In `src/sessions.mjs`, `saveSession` currently truncates the history to the last 120 messages before validation. This can discard the required first system message and make an otherwise valid session impossible to save.

Keep the original first system message and the newest 119 messages whenever history exceeds 120 entries. The saved history must contain at most 120 messages. Histories at or below the limit must be preserved unchanged. Keep the existing session schema, load-time validation, message-count limit, and atomic save behavior intact.

Add `test/session-history.test.mjs` with regression tests for histories over the limit, exactly at the limit, and short histories. The long-history case must save and reload successfully, preserve the original system context, and retain the newest 119 messages in their original order.

Do not modify the evaluator or external verifier.
