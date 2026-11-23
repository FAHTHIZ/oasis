# Durable execution: the intent journal

Source: `src/intent-journal.mjs`, the tool path and session restore in `src/agent.mjs`, `journalId` in `src/sessions.mjs`.

A session is saved while a turn runs, at most every few seconds. If OASIS stops (a crash, a closed terminal, a server restart), the calls that had finished keep their results and the one that was running is marked `Interrupted: ... may have partly run or not run at all`. Two gaps remained:

- A call that finished in the few seconds after the last save is not in the restored transcript at all, so the model may run it again.
- For a call marked interrupted, the model has to guess whether it happened. Guessing "no" repeats a commit, a migration or a deploy; guessing "yes" skips work.

The intent journal closes both by deciding from the world, not from memory.

## How it works

Before a consequential call starts, after it was authorized, OASIS appends an `intent` record to the session's journal and fsyncs it. When the call returns (or fails), it appends a `done` record. The journal is JSON Lines under the session folder (`sessions/<workspace>/journal/<id>.jsonl`, mode 600). A torn last line from a crash mid-write is skipped.

Each intent carries **probes**: observations taken just before the call, with the state the call should leave where that is known in advance.

| Probe | Taken for | Holds |
| --- | --- | --- |
| `file` | `write_file`, `edit_file`, `multi_edit`, `delete_file`, `notebook_edit`, generated media | SHA-256 of the target before (or its absence); for `write_file` the hash of the content it will write, for `delete_file` absence |
| `paths` | `run_command`, `run_shell` | Hashes of the paths the command line names (the same prediction as [effect contracts](EFFECTS.md)) |
| `git_head` | `git_commit`, and commands that commit, merge, reset, pull, push or switch | `HEAD` before |

Calls journaled: commands, file edits, installs, extension and MCP server configuration, commits, pull requests, deploys, generated media, and every MCP tool call. Read-only tools are not journaled. Subagent calls are not journaled; their parent sees their result.

## After a restart

When a saved session is resumed, OASIS reads its journal and finds:

- **in doubt**: an intent with no `done` record — OASIS stopped while the call was running;
- **unrecorded**: a `done` record whose result is missing from the transcript or only a placeholder.

For each, it re-reads the probes and decides:

| State | Meaning |
| --- | --- |
| `applied` | The target is exactly as the call would leave it |
| `not_applied` | Every target is unchanged since before the call |
| `partial` | Some targets match, others do not |
| `changed` | The targets changed, but not to a state known in advance (a command, a commit) |
| `completed` | The call finished successfully and there is nothing to probe |
| `unknown` | Nothing to check from here, such as an MCP call to an outside service |

The `Interrupted:` placeholders in the restored transcript are replaced with what was found, and the next turn starts with an `<in-doubt-actions>` note listing every such action and its state, so the model does not repeat what took effect and checks what cannot be told from the workspace.

## Right after a failure

The same checks run without a restart. When a journaled call fails (it threw, timed out or lost its connection) OASIS re-reads its probes and what the [effect contract](EFFECTS.md) saw change. If the targets show the call took effect, the error result carries `afterFailure` with the state (`applied`, `partial` or `changed`), the findings and the note "Check the result before repeating it; repeating may do it twice." A failure that changed nothing gets no note. The [reliability laboratory](RELIABILITY-LAB.md) found the case this closes: a command whose reply was lost after it appended to a file was repeated, so the line was written twice. `OASIS_AFTER_FAILURE_CHECK=0` turns the live check off.

## What it stores

Digests, a short summary of each call (its command line or target path, 200 characters at most), the probe hashes and exit status. Never file contents, full arguments or results. Journals are compacted past 2 MB (unresolved intents are always kept) and removed after 14 days without a write.

## Turning it off

`OASIS_INTENT_JOURNAL=0`, or `"intentJournal": false` in settings.

## Compared with workflow engines

Durable execution engines such as Temporal and Restate make a workflow resumable by recording each activity's result and requiring activities to be idempotent, so a retry is harmless. Agent tools are not idempotent and the model chooses them at run time, so retry-by-default is unsafe. The journal takes the write-ahead record from those engines but replaces "retry and rely on idempotency" with "observe and decide": each in-doubt action is resolved from probes of the state it was meant to change. Claude Code, Codex and Aider restore the conversation, not the status of the action that was running.

References: [Temporal: activities and retries](https://docs.temporal.io/activities), [Restate: durable execution](https://docs.restate.dev/concepts/durable_execution), [ARIES write-ahead logging (Mohan et al., 1992)](https://dl.acm.org/doi/10.1145/128765.128770).

`/insights` (and `oasis insights`) counts failed calls that had in fact taken effect, per command, under Effects.
