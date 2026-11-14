# Agent evaluation run — 2026-11-14

OASIS 1.3.0 · 1 verified matched tasks × 1 requested trial(s) · shared endpoint `127.0.0.1:3001 (recorded)`.

Headline pass rate is a macro-average of per-task pass rates. A task contributes only when every completed agent has exactly the requested number of distinct trials, complete matching SHA-256 task fingerprints, and matching category/difficulty metadata.

| Agent | Requested model | CLI-reported model | Pass rate | Passed trials | Median trial time | Tokens | Total reported cost |
|---|---|---|---:|---:|---:|---:|---:|
| OASIS 1.3.0 (gpt-oss-20b) | gpt-oss-20b | gpt-oss-20b | 100% | 1/1 | 349.6 s | 60242 | $0.0020 |

## Gateway record

Same model verified: every scored agent's calls were served by `gpt-oss-20b`, as reported by the upstream.

| Agent | Calls | Failed calls | Served model(s) | Provider(s) | Input tokens | Output tokens |
|---|---:|---:|---|---|---:|---:|
| oasis | 13 | 3 | gpt-oss-20b ×10 | none reported | 62710 | 2383 |

## Interpretation limits

- Agent adapters do not use identical tool surfaces, approval modes, or sandbox policies. This is a configured-product comparison, not an isolated measurement of harness code.
- Token and cost fields are adapter-reported usage. Cost may be absent or calculated differently by providers; it is not a normalized billing audit.
- Fewer than two agents completed a run; this is not a head-to-head comparison.
- Only 1 task(s) have complete, identical SHA-256 fingerprints and the requested number of trials across all completed agents; the guide targets at least 50 representative tasks.
- Only 1 trial(s) per task were requested. One trial is a smoke test; three trials are a minimum diagnostic repeat, not a confidence interval or significance test.
- No verified matched task is labeled large; this run does not test larger repository-level work.
- 1 shared task(s) were excluded because an agent failed a trial while the upstream was refusing its requests with HTTP 429: clamp-integer.
- Every scored agent was served model gpt-oss-20b, but the gateway could not confirm one upstream provider for all of them (missing or different provider fields); serving stacks can differ in quantization and limits.

## Run provenance

| Agent | CLI version | Source revision | Runtime |
|---|---|---|---|
| OASIS | 1.3.0 | b135fbc371394e6a8b7d4d9acdb91773643eaef7 | v22.21.0 / linux / x64 |

## Task coverage

Shared task IDs: clamp-integer, safe-relative-path.
Verified matched tasks: safe-relative-path.
Excluded task IDs: clamp-integer.

<details><summary>Per-task results</summary>

| Task | Category | Difficulty | OASIS |
|---|---:|---:|---:|
| `safe-relative-path` | security-boundaries | medium | 100% |

</details>

Raw per-trial JSON files contain verifier output, changed files, and adapter-reported usage. Keep those files with this summary; the summary alone is not a complete audit record.
