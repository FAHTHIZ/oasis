# Cross-agent task benchmark — 2026-11-08

OASIS 1.1.1 · 1 verified matched tasks × 1 requested trial(s) · shared endpoint `127.0.0.1:20128`.

Headline pass rate is a macro-average of per-task pass rates. A task contributes only when every completed agent has exactly the requested number of distinct trials, complete matching SHA-256 task fingerprints, and matching category/difficulty metadata.

| Agent | Requested model | CLI-reported model | Pass rate | Passed trials | Median trial time | Tokens | Total reported cost |
|---|---|---|---:|---:|---:|---:|---:|
| OASIS 1.1.1 (openrouter/nvidia/nemotron-3-ultra-550b-a55b:free) | openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | 100% | 1/1 | 44.3 s | 55380 | $0.0000 |
| Claude Code 2.1.319 (Claude Code) (openrouter/nvidia/nemotron-3-ultra-550b-a55b:free) | openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | 100% | 1/1 | 121.3 s | 52152 | $0.2785 |

## Interpretation limits

- Agent adapters do not use identical tool surfaces, approval modes, or sandbox policies. This is a configured-product comparison, not an isolated measurement of harness code.
- A shared gateway URL and requested model ID do not prove that every client was served the same underlying model or model version. Verify gateway/provider logs before calling this a same-model harness comparison.
- Token and cost fields are adapter-reported usage. Cost may be absent or calculated differently by providers; it is not a normalized billing audit.
- Only 1 task(s) have complete, identical SHA-256 fingerprints and the requested number of trials across all completed agents; the guide targets at least 50 representative tasks.
- Only 1 trial(s) per task were requested. One trial is a smoke test; three trials are a minimum diagnostic repeat, not a confidence interval or significance test.
- No verified matched task is labeled large; this run does not test larger repository-level work.

## Run provenance

| Agent | CLI version | Source revision | Runtime |
|---|---|---|---|
| OASIS | 1.1.1 | 5c2f00860bd1a7986b1e4ee5eded341bf69b28c6 | v24.11.0 / linux / x64 |
| Claude Code | 2.1.319 (Claude Code) | 5c2f00860bd1a7986b1e4ee5eded341bf69b28c6 | v24.11.0 / linux / x64 |

## Task coverage

Shared task IDs: clamp-integer.
Verified matched tasks: clamp-integer.

<details><summary>Per-task results</summary>

| Task | Category | Difficulty | OASIS | Claude Code |
|---|---:|---:|---:|---:|
| `clamp-integer` | utility-logic | small | 100% | 100% |

</details>

Raw per-trial JSON files contain verifier output, changed files, and adapter-reported usage. Keep those files with this summary; the summary alone is not a complete audit record.
