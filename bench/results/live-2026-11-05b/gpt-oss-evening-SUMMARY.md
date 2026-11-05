# Cross-agent task benchmark — 2026-11-05

OASIS 1.1.0 · 3 verified matched tasks × 1 requested trial(s) · shared endpoint `127.0.0.1:8788`.

Headline pass rate is a macro-average of per-task pass rates. A task contributes only when every completed agent has exactly the requested number of distinct trials, complete matching SHA-256 task fingerprints, and matching category/difficulty metadata.

| Agent | Requested model | CLI-reported model | Pass rate | Passed trials | Median trial time | Tokens | Total reported cost |
|---|---|---|---:|---:|---:|---:|---:|
| OpenCode 1.19.5 (bench/gpt-oss-20b) | bench/gpt-oss-20b | bench/gpt-oss-20b | 33.3% | 1/3 | 242.2 s | 88303 | $0.0000 |
| OASIS 1.1.0 (gpt-oss-20b) | gpt-oss-20b | gpt-oss-20b | 66.7% | 2/3 | 475.6 s | 330142 | $0.0000 |

## Interpretation limits

- Agent adapters do not use identical tool surfaces, approval modes, or sandbox policies. This is a configured-product comparison, not an isolated measurement of harness code.
- A shared gateway URL and requested model ID do not prove that every client was served the same underlying model or model version. Verify gateway/provider logs before calling this a same-model harness comparison.
- Token and cost fields are adapter-reported usage. Cost may be absent or calculated differently by providers; it is not a normalized billing audit.
- Only 3 task(s) have complete, identical SHA-256 fingerprints and the requested number of trials across all completed agents; the guide targets at least 50 representative tasks.
- Only 1 trial(s) per task were requested. One trial is a smoke test; three trials are a minimum diagnostic repeat, not a confidence interval or significance test.
- No verified matched task is labeled large; this run does not test larger repository-level work.
- The selected agents do not all have one identical, explicitly requested model ID.

## Run provenance

| Agent | CLI version | Source revision | Runtime |
|---|---|---|---|
| OpenCode | 1.19.5 | ce3363a21848de69fc4fb0a96dc51381a693d49e | v22.20.0 / linux / x64 |
| OASIS | 1.1.0 | 4ce9fdb67fe628345cae38bbe2ccd2bbc2113641 | v22.20.0 / linux / x64 |

## Task coverage

Shared task IDs: clamp-integer, safe-relative-path, taskflow-search.
Verified matched tasks: clamp-integer, safe-relative-path, taskflow-search.

<details><summary>Per-task results</summary>

| Task | Category | Difficulty | OpenCode | OASIS |
|---|---:|---:|---:|---:|
| `clamp-integer` | utility-logic | small | 100% | 100% |
| `safe-relative-path` | security-boundaries | medium | 0% | 100% |
| `taskflow-search` | data-structures | medium | 0% | 0% |

</details>

Raw per-trial JSON files contain verifier output, changed files, and adapter-reported usage. Keep those files with this summary; the summary alone is not a complete audit record.
