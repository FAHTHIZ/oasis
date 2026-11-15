# Agent evaluation run — 2026-11-15

OASIS 1.3.0 · 3 verified matched tasks × 1 requested trial(s) · shared endpoint `127.0.0.1:11434`.

Headline pass rate is a macro-average of per-task pass rates. A task contributes only when every completed agent has exactly the requested number of distinct trials, complete matching SHA-256 task fingerprints, and matching category/difficulty metadata.

| Agent | Requested model | CLI-reported model | Pass rate | Passed trials | Median trial time | Tokens | Total reported cost |
|---|---|---|---:|---:|---:|---:|---:|
| OASIS 1.3.0 (qwen3:1.7b-oasis) | qwen3:1.7b-oasis | qwen3:1.7b-oasis | 33.3% | 1/3 | 1284.2 s | 75769 | $0.0000 |

## Interpretation limits

- Agent adapters do not use identical tool surfaces, approval modes, or sandbox policies. This is a configured-product comparison, not an isolated measurement of harness code.
- Token and cost fields are adapter-reported usage. Cost may be absent or calculated differently by providers; it is not a normalized billing audit.
- Fewer than two agents completed a run; this is not a head-to-head comparison.
- Only 3 task(s) have complete, identical SHA-256 fingerprints and the requested number of trials across all completed agents; the guide targets at least 50 representative tasks.
- Only 1 trial(s) per task were requested. One trial is a smoke test; three trials are a minimum diagnostic repeat, not a confidence interval or significance test.
- No verified matched task is labeled large; this run does not test larger repository-level work.
- OASIS: 1 scored trial(s) ended in an agent or provider error before verification and count as failures (first: Task exceeded the 1500-second task timeout.).
- A shared gateway URL and requested model ID do not prove that every client was served the same underlying model or model version. Verify gateway/provider logs (or use --upstream, which records them) before calling this a same-model harness comparison.

## Run provenance

| Agent | CLI version | Source revision | Runtime |
|---|---|---|---|
| OASIS | 1.3.0 | e0179321459009ac30ea5e892a4c8ba85c4f1051 (HEAD moved to 72d63582c607397e3f2d8208023d1d5fd4afb54c during the run; the loaded code is the first revision) | v22.21.1 / linux / x64 |

## Task coverage

Shared task IDs: clamp-integer, dedupe-names, slice-lines.
Verified matched tasks: clamp-integer, dedupe-names, slice-lines.

<details><summary>Per-task results</summary>

| Task | Category | Difficulty | OASIS |
|---|---:|---:|---:|
| `clamp-integer` | utility-logic | small | 0% |
| `dedupe-names` | utility-logic | small | 100% |
| `slice-lines` | utility-logic | small | 0% |

</details>

Raw per-trial JSON files contain verifier output, changed files, and adapter-reported usage. Keep those files with this summary; the summary alone is not a complete audit record.
