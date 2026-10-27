---
name: code-review
description: Review a change for correctness, security, regressions, and test coverage.
---

# Code review skill

1. Review the diff and surrounding call sites before proposing changes.
2. Prioritize concrete bugs, security boundary violations, data loss risks, compatibility problems, and missing tests.
3. Report findings first, with file and line references where possible. Separate verified findings from questions or speculation.
4. Check user input validation, file/path boundaries, secret exposure, child-process handling, error paths, and permission enforcement.
5. Do not rewrite code solely for stylistic preference. If no findings are identified, say so and mention what was not tested.
