---
name: verify
description: Independently verify that a finished change does what was asked: rerun tests, build, lint, and exercise the behavior end to end before reporting done.
---

# Verify before reporting done

1. Restate what "done" means for the request as 2-5 checkable statements.
2. Run the project's real checks, not a subset: the test command, type checker, linter and build
   that CI runs (read `.github/workflows/*` to find them). Record exact commands and exit codes.
3. Exercise the changed behavior directly (see the `run` skill): one normal case, one edge case,
   one failure case.
4. Review the full diff (`git diff` against the base) for leftovers: debug prints, commented-out
   code, unrelated edits, secrets, TODOs you introduced.
5. If anything fails, fix it and repeat from step 2. Do not report success on static reading alone.
6. Report: each statement from step 1 with evidence (command + result), and anything you could not
   verify and why.
