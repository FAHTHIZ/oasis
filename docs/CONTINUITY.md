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

### Chats and subagents

- A chat gateway (Slack, Discord, Telegram and the others) that continues a session with `/resume` adds the same summary to its reply (`The workspace changed since then: ...`), and the model gets the `<workspace-drift>` note before the next message.
- A subagent transcript saved with the session (`<session>.agents/agent_N.json`) carries its own fingerprint of the files that agent read or wrote, in its own checkout when it worked in a worktree. When the parent sends a message to that agent after a restart, the message starts with a `<workspace-drift>` note if any of those files changed, so the agent does not act on what it read before. Files only the parent or other agents touched are not named. An `agent.world_drift` event is recorded.

Content hashes, not modification times, decide: a `touch`, or a checkout that restores the same bytes, is not drift. Nothing is shown when nothing moved.

`OASIS_WORLD_DRIFT=0` or `"worldDrift": false` in settings turns it off (nothing is recorded or compared).

## Check memory

A check (a test, build, lint or type-check command OASIS recognises) that finishes is remembered against a fingerprint of the working tree: the commit's tree plus the content of every uncommitted and untracked file that Git does not ignore. Records live in the OASIS directory (`check-memory/`), never in the repository, with secrets in the command line redacted (`src/check-memory.mjs`).

- At the start of a session, checks already run on exactly the current files in earlier sessions are listed for the model with how they ended and when (`[OASIS check memory] These checks already ran on exactly the current files...`). It need not rerun one only to learn the result. Any edit changes the fingerprint, so a result is never offered for files it did not run on.
- When a check ends differently from an earlier run on the same fingerprint (it passed on these files and now fails, or the reverse), the files cannot be the cause. The tool result says so and points at what is outside them: installed dependencies, ignored files such as `.env`, services, the clock or the machine. The start-of-session list marks such checks as giving different results.
- Runs that cannot stand for the whole check are not remembered: unfinished or timed-out runs, an exit status hidden by a pipe, runs filtered to some tests, runs where no test ran, and runs that changed files.
- Outside Git, or with more than 2,000 changed files, or when fingerprinting takes over 3 seconds, nothing is recorded. Nothing is written to `.git`.

`OASIS_CHECK_MEMORY=0` or `"checkMemory": false` in settings turns it off. Build systems keep test results by input hash and rerun only what changed ([Bazel `--cache_test_results`](https://bazel.build/reference/command-line-reference), [Turborepo caching](https://turborepo.com/docs/crafting-your-repository/caching)); check memory brings the same footing to an agent, which otherwise reruns a suite in every new session, and uses a flip on identical inputs as a diagnosis rather than only a cache miss. Tests: `test/check-memory.test.mjs`.

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

`/insights` counts resumed sessions that found the workspace changed.
