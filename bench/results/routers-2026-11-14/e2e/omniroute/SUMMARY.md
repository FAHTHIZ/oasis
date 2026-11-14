# Agent evaluation run — 2026-11-14

OASIS 1.3.0 · 2 verified matched tasks × 1 requested trial(s) · shared endpoint `127.0.0.1:20128 (recorded)`.

Headline pass rate is a macro-average of per-task pass rates. A task contributes only when every completed agent has exactly the requested number of distinct trials, complete matching SHA-256 task fingerprints, and matching category/difficulty metadata.

| Agent | Requested model | CLI-reported model | Pass rate | Passed trials | Median trial time | Tokens | Total reported cost |
|---|---|---|---:|---:|---:|---:|---:|
| OASIS 1.3.0 (ovh/gpt-oss-20b) | ovh/gpt-oss-20b | ovh/gpt-oss-20b | 0% | 0/2 | 425.9 s | 99116 | $0.0033 |

## Gateway record

Same model NOT verified from the gateway record.

| Agent | Calls | Failed calls | Served model(s) | Provider(s) | Input tokens | Output tokens |
|---|---:|---:|---|---|---:|---:|
| oasis | 24 | 0 | gpt-oss-20b ×21, keepalive ×3 | none reported | 95770 | 3346 |

## Interpretation limits

- Agent adapters do not use identical tool surfaces, approval modes, or sandbox policies. This is a configured-product comparison, not an isolated measurement of harness code.
- Token and cost fields are adapter-reported usage. Cost may be absent or calculated differently by providers; it is not a normalized billing audit.
- Fewer than two agents completed a run; this is not a head-to-head comparison.
- Only 2 task(s) have complete, identical SHA-256 fingerprints and the requested number of trials across all completed agents; the guide targets at least 50 representative tasks.
- Only 1 trial(s) per task were requested. One trial is a smoke test; three trials are a minimum diagnostic repeat, not a confidence interval or significance test.
- No verified matched task is labeled large; this run does not test larger repository-level work.
- OASIS: 1 scored trial(s) ended in an agent or provider error before verification and count as failures (first: The model stream was interrupted: Provider returned empty content).
- The recording gateway did not see every completed agent served by one identical model ID (see the gateway table); this is not a verified same-model comparison.

## Run provenance

| Agent | CLI version | Source revision | Runtime |
|---|---|---|---|
| OASIS | 1.3.0 | b135fbc371394e6a8b7d4d9acdb91773643eaef7 | v22.21.0 / linux / x64 |

## Task coverage

Shared task IDs: clamp-integer, safe-relative-path.
Verified matched tasks: clamp-integer, safe-relative-path.

<details><summary>Per-task results</summary>

| Task | Category | Difficulty | OASIS |
|---|---:|---:|---:|
| `clamp-integer` | utility-logic | small | 0% |
| `safe-relative-path` | security-boundaries | medium | 0% |

</details>

Raw per-trial JSON files contain verifier output, changed files, and adapter-reported usage. Keep those files with this summary; the summary alone is not a complete audit record.
