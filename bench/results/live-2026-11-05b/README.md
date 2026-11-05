# Live runs, 2026-11-05 (second set)

Summaries written by `npm run bench:live`; the write-up is [docs/research/LIVE_COMPARISON_2026-11-05b.md](../../../docs/research/LIVE_COMPARISON_2026-11-05b.md).

- `gpt-oss-morning-*`: OASIS and Aider on `gpt-oss-20b` (Pollinations).
- `gpt-oss-evening-*`: OpenCode and OASIS on `gpt-oss-20b`. The "Source revision" column shows HEAD at the end of the run (`ce3363a`, `4ce9fdb`). Both agents ran with code loaded at about `bb25890`, before the harmony tool-name fix `cc58a59`; the harness has recorded the loaded revision since `729816f`.
- `nemotron-oasis-aider-*`: OASIS and Aider on Nemotron 3 Ultra (OpenRouter free), `safe-relative-path` only.
- `nemotron-opencode-INVALID-*`: OpenCode on the same model. Not valid: it ran before the `PWD` fix (`bb25890`) and worked outside the task workspace.

The model ID in some files is `bench-model`: the gateway rewrote every request to the one model named above.
