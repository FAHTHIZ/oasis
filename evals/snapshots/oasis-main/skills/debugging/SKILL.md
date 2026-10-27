---
name: debugging
description: Find the smallest reproducible cause of a bug and verify the fix.
---

# Debugging skill

1. Reproduce the reported behavior before editing. Inspect the call path and relevant tests.
2. Write down the expected behavior and the observed behavior; do not confuse symptoms with the root cause.
3. Prefer a focused fix with a regression test. Do not broadly rewrite unrelated code to hide a failing check.
4. Run the narrowest relevant test, then the wider project checks when practical.
5. If you cannot reproduce a bug, explain what you inspected and what evidence is missing.
6. Never claim a fix is verified unless a relevant command completed successfully.
