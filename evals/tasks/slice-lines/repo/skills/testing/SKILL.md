---
name: testing
description: Choose meaningful tests, run them, interpret failures, and prevent regressions.
---

# Testing skill

1. Inspect the existing test runner and conventions before adding dependencies.
2. Add tests for the user's expected behavior and at least one relevant edge case.
3. Prefer deterministic tests with temporary directories and mocked external boundaries.
4. Do not mark a test passed based only on static inspection. Run it and record the actual exit status.
5. If a test needs network access, credentials, a real device, or a service that is unavailable, state that limitation clearly.
6. Avoid tests that mutate a developer's real home directory or run an unreviewed installer.
