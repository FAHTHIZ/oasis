# World drift on resume

A saved OASIS session remembers what the workspace looked like when the model last saw it. Resume it later and that memory can be wrong: someone committed, switched branches, rebased, or edited a file the conversation had read. Without being told, the model edits from stale contents or reasons about a branch it is no longer on.

## What OASIS does

Every session save (`src/sessions.mjs`) records a small fingerprint of the workspace (`src/world-drift.mjs`):

- `head` and `branch`: the commit and branch checked out (Git work trees only);
- `files`: a SHA-256 prefix of every file the conversation read, edited, wrote or deleted, taken from its tool calls and `apply_patch` headers, capped at 300 paths; missing files are recorded as missing;
- `dirty`: the number of paths with uncommitted changes.

On resume (`oasis --resume`, `oasis --continue`, `/resume`), the fingerprint is compared with the workspace. When something the conversation depends on moved:

- the terminal prints one line, for example `[session] The workspace changed since this session was saved: 1 new commit since then: 3f2a1c0 Fix login. Changed: src/app.js.`;
- the first turn starts with a `<workspace-drift>` note for the model naming the new commits (with subjects), a branch switch, a HEAD that moved back or to unrelated history (rebase, reset, amend), and each known file that changed, was deleted or now exists, with the instruction to read those files again before relying on them;
- a `world_drift` session event is recorded.

Content hashes, not modification times, decide: a `touch`, or a checkout that restores the same bytes, is not drift. Nothing is shown when nothing moved.

`OASIS_WORLD_DRIFT=0` or `"worldDrift": false` in settings turns it off (nothing is recorded or compared).

## Prior art

- Claude Code resume and checkpoints restore the conversation and the edits Claude made; manual and external changes are not tracked and not reported ([Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing)).
- Codex resume restores the transcript only ([openai/codex discussion 9618](https://github.com/openai/codex/discussions/9618)).
- OASIS's own `file-state.mjs` reminder notices external edits between turns of a live process, but its records live in memory and are lost when the process exits.
- The intent journal (`DURABLE-EXECUTION.md`) decides calls that were in flight; it does not cover what others changed afterwards.

## Cost and limits

Measured on the OASIS repository with 300 tracked files: capture 107 to 144 ms (median about 127 ms), comparison about 91 ms. Capture stops at a 1.5 s budget and marks the fingerprint `truncated`; files over 8 MiB are fingerprinted by size. Paths outside the workspace are never recorded, and saved fingerprints are re-validated on load (absolute or `..` paths are dropped).

Only files the conversation touched through file tools are tracked; a file read through `run_command cat` is not.

## Acceptance

`test/world-drift.test.mjs` (7 tests): no drift for an unchanged workspace, a touch, or same-bytes rewrite; changed, deleted and newly created known files named while unrelated files are ignored; new commits reported as `ahead` with subjects, branch switches, reset back (`behind`) and amended history (`other`) told apart; disabled by `OASIS_WORLD_DRIFT=0`; sanitizing of saved fingerprints; and an end-to-end save, external commit, resume and two turns where only the first model request carries the note.
