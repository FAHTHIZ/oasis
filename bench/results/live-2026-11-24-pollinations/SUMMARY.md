# Live run: release check on a free hosted endpoint (24 November 2026)

- Command: `OASIS_CONFIG_DIR=… node src/cli.mjs eval --task taskflow-csv,conflicting-sources-answer,sales-region-report,release-notes-brief,project-schedule-plan,archive-old-logs --trials 1 --timeout-seconds 1200 --yes`
- OASIS 0.10.0 at `5fef1a1b`, Node 22.21.1, Linux x64, 2 CPU cores. `f7f051ea` landed during the run; it changed only the README, docs and a README badge, not code the run used.
- Endpoint: `https://text.pollinations.ai/openai` (OpenAI-compatible, anonymous tier, `apiKey` set to `anonymous`), model alias `openai`, served by gpt-oss-20b at the time of the run. `maxSteps` 40, `maxCommandSeconds` 120, permission mode auto. No charge, so cost is unknown.
- One trial per task, one task per area (coding, research, analysis, writing, planning, automation): a smoke test before the 0.11.0 release, not a score. Raw file: [results.json](results.json).

| Task | Area | Result | Time | Tokens | OASIS's own verdict | What happened |
| --- | --- | --- | ---: | ---: | --- | --- |
| `taskflow-csv` | coding | fail | 587 s | 104,110 | rejected | The model's new `test/csv.test.mjs` called `describe` without importing it, so the project tests failed; OASIS reported the task unfinished |
| `conflicting-sources-answer` | research | pass | 482 s | 58,822 | evidenced | Read all four sources, gave the current figure and named both outdated ones under `Contradiction:` |
| `sales-region-report` | analysis | pass | 764 s | 112,389 | evidenced | Wrote a script, deduplicated orders, skipped bad rows, wrote `report/summary.json` and `summary.md` |
| `release-notes-brief` | writing | pass | 180 s | 19,600 | verified | Wrote `RELEASE_NOTES.md` in three tool calls |
| `project-schedule-plan` | planning | pass | 674 s | 102,125 | verified | Wrote the plan and its own checker, ran it |
| `archive-old-logs` | automation | fail | 961 s | 130,686 | none | The script ran and archived every log with a manifest, then the endpoint kept answering with an upstream error ("provider returned invalid or omitted terminal usage") until the stream restarts ran out, so the turn never finished |

Pass rate 4/6, median 631 s. Self-assessment: OASIS reached a verdict on 5 trials; all 3 decided ones matched the hidden verifier (2 true positives, 1 true negative, 0 overclaims, 0 underclaims), and the 2 it called only evidenced both passed.

Neither failure pointed to a defect in OASIS: one is the model's test file, the other is the shared endpoint failing past the retry limit (`OASIS_STREAM_MAX_RETRIES`). No code was changed because of this run.
