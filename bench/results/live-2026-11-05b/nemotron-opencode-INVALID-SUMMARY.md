# Agent evaluation run — 2026-11-05

OASIS 1.1.0 · 1 verified matched tasks × 1 requested trial(s) · shared endpoint `127.0.0.1:8789`.

Headline pass rate is a macro-average of per-task pass rates. A task contributes only when every completed agent has exactly the requested number of distinct trials, complete matching SHA-256 task fingerprints, and matching category/difficulty metadata.

| Agent | Requested model | CLI-reported model | Pass rate | Passed trials | Median trial time | Tokens | Total reported cost |
|---|---|---|---:|---:|---:|---:|---:|
| OpenCode 1.19.5 (bench/bench-model) | bench/bench-model | bench/bench-model | 0% | 0/1 | 280.9 s | 71819 | $0.0000 |

## Interpretation limits

- Agent adapters do not use identical tool surfaces, approval modes, or sandbox policies. This is a configured-product comparison, not an isolated measurement of harness code.
- A shared gateway URL and requested model ID do not prove that every client was served the same underlying model or model version. Verify gateway/provider logs before calling this a same-model harness comparison.
- Token and cost fields are adapter-reported usage. Cost may be absent or calculated differently by providers; it is not a normalized billing audit.
- Fewer than two agents completed a run; this is not a head-to-head comparison.
- Only 1 task(s) have complete, identical SHA-256 fingerprints and the requested number of trials across all completed agents; the guide targets at least 50 representative tasks.
- Only 1 trial(s) per task were requested. One trial is a smoke test; three trials are a minimum diagnostic repeat, not a confidence interval or significance test.
- No verified matched task is labeled large; this run does not test larger repository-level work.

## Run provenance

| Agent | CLI version | Source revision | Runtime |
|---|---|---|---|
| OpenCode | 1.19.5 | ce18cbf7f810859e95619a54e1273d3f43c59f4c | v22.20.0 / linux / x64 |

## Task coverage

Shared task IDs: safe-relative-path.
Verified matched tasks: safe-relative-path.

<details><summary>Per-task results</summary>

| Task | Category | Difficulty | OpenCode |
|---|---:|---:|---:|
| `safe-relative-path` | security-boundaries | medium | 0% |

</details>

Raw per-trial JSON files contain verifier output, changed files, and adapter-reported usage. Keep those files with this summary; the summary alone is not a complete audit record.
