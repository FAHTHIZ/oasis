# Live run: non-code eval tasks on a free hosted endpoint (23 November 2026)

- Command: `OASIS_CONFIG_DIR=… node src/cli.mjs eval --task archive-old-logs,conflicting-sources-answer,meeting-action-items,project-schedule-plan,release-notes-brief,remove-hardcoded-key,sales-region-report --trials 1 --timeout-seconds 1200 --yes`
- OASIS 1.8.0 at `b7c3daab`, Node 22.21.1, Linux x64.
- Endpoint: `https://text.pollinations.ai/openai` (OpenAI-compatible, anonymous tier, no key; OASIS needs a non-empty `apiKey`, so it was set to `anonymous`). Model alias `openai`, which the service serves with gpt-oss-20b at the time of the run. `maxSteps` 40, `maxCommandSeconds` 120, permission mode auto. No charge, so cost is reported as unknown.
- One trial per task: a smoke test, not a score. The service is shared and its model behind an alias can change, so a rerun may differ. Raw file: [results.json](results.json).

| Task | Result | Time | Tokens | Tool calls | OASIS's own verdict | What happened |
| --- | --- | ---: | ---: | ---: | --- | --- |
| `archive-old-logs` | pass | 319 s | 48,202 | 7 | verified | Wrote the script, the first run crashed, fixed it, the second run succeeded |
| `conflicting-sources-answer` | fail | 404 s | 50,761 | 7 | rejected | Read two of the four files in `sources/`, so the press release and its repost were never seen; wrote `## Contradiction` as a heading where a paragraph beginning `Contradiction:` was asked for |
| `meeting-action-items` | pass | 134 s | 14,667 | 2 | verified | Read the notes, wrote `notes/actions.json` |
| `project-schedule-plan` | pass | 360 s | 38,314 | 6 | verified | Wrote the plan, reread it, and asked a subagent to check it |
| `release-notes-brief` | pass | 226 s | 25,067 | 4 | verified | Wrote the brief; one stray `run_command RELEASE_NOTES.md` |
| `remove-hardcoded-key` | pass | 539 s | 69,688 | 11 | unverified | Moved the key to the environment, ran the tests; one call with invalid JSON arguments was refused and resent |
| `sales-region-report` | pass | 585 s | 74,376 | 10 | evidenced | `python - <<'PY'` through `run_command` failed (no shell), wrote a script instead, created the missing `report/` folder, reran |

Pass rate 6/7, median 360 s. Self-assessment: OASIS reached a verdict on all 7 trials before the hidden verifier ran; all 5 decided ones matched (4 true positives, 1 true negative, 0 overclaims, 0 underclaims), and the 2 it called unverified or only evidenced both passed. Requests took about 5 to 15 seconds each on the shared service; time is dominated by the endpoint, not OASIS.

## How the earlier trials on this endpoint changed OASIS

Single trials of `sales-region-report` on the same endpoint, before this run, failed for reasons that were OASIS's, not the model's:

- `python -c` was refused because nobody was there to approve it, and the refusal did not say so; the model kept retrying. The message now says the command needs approval nobody can give in an unattended run and suggests writing a script file (`b9b4d1e9`).
- The model wrote a scratch file, then could not delete it: auto-approval refused deleting any file. A file the session created itself, unchanged since, can now be deleted (`b7c3daab`).
- Heredocs and pipes passed to `run_command` were run as literal arguments with no hint why they failed. Results now carry a note that `run_command` takes no shell syntax (`4cf88526`).

With those fixes, 4 of the first 5 tasks passed in this run, and 6 of 7 overall.

## Changes made because of this run

The one failure showed a gap in the task contract, not only in the model: OASIS could not see that half the sources were unread, or that the exact opening the request asked for was missing.

- Reading a workspace file now leaves an evidence event (path and digest only; an unchanged reread adds nothing).
- A request that confines the answer to a folder ("using only the files in sources/") gets a `sources_read` criterion: every file in the folder (up to 40) must have been read, by `read_file` or a shell command that names it.
- A request for a line that begins with exact words ("a paragraph that begins with \"Contradiction:\"") gets an `opening` criterion, checked in the written file; Markdown emphasis is ignored, a heading without the words is not accepted.
- `cites_sources` accepts cited workspace files, not only URLs, and each cited file must have been read.

An unmet criterion goes back to the model once before it may finish (`test/local-sources-criteria.test.mjs`).
