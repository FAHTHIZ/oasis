# Cross-agent task benchmark — 2026-11-05

OASIS 1.1.0 · 3 verified matched tasks × 1 requested trial(s) · shared endpoint `127.0.0.1:8787`.

Headline pass rate is a macro-average of per-task pass rates. A task contributes only when every completed agent has exactly the requested number of distinct trials, complete matching SHA-256 task fingerprints, and matching category/difficulty metadata.

| Agent | Requested model | CLI-reported model | Pass rate | Passed trials | Median trial time | Tokens | Total reported cost |
|---|---|---|---:|---:|---:|---:|---:|
| OASIS 1.1.0 (gemini-flash-lite-latest) | gemini-flash-lite-latest | gemini-flash-lite-latest | 0% | 0/3 | 75.3 s | 225163 | $0.0000 |
| Gemini CLI 0.67.0 (gemini-flash-lite-latest) | gemini-flash-lite-latest | gemini-flash-lite-latest | 33.3% | 1/3 | 396.3 s | n/a | n/a |
| OpenCode | — | — | not run | — | — | — | — |
| Aider aider 0.86.2 (openai/gemini-flash-lite-latest) | openai/gemini-flash-lite-latest | openai/gemini-flash-lite-latest | 33.3% | 1/3 | 5.2 s | 3038 | n/a |

## Interpretation limits

- Agent adapters do not use identical tool surfaces, approval modes, or sandbox policies. This is a configured-product comparison, not an isolated measurement of harness code.
- A shared gateway URL and requested model ID do not prove that every client was served the same underlying model or model version. Verify gateway/provider logs before calling this a same-model harness comparison.
- Token and cost fields are adapter-reported usage. Cost may be absent or calculated differently by providers; it is not a normalized billing audit.
- Only 3 task(s) have complete, identical SHA-256 fingerprints and the requested number of trials across all completed agents; the guide targets at least 50 representative tasks.
- Only 1 trial(s) per task were requested. One trial is a smoke test; three trials are a minimum diagnostic repeat, not a confidence interval or significance test.
- No verified matched task is labeled large; this run does not test larger repository-level work.
- The selected agents do not all have one identical, explicitly requested model ID.

## Agents not run

- OpenCode: every trial ended in an agent error before verification (first: OpenCode exited with code 1: t9jGOfyPZ1mefYKehTan+85wOEaIDPdCOpN1M1L7zKhQQrVvFwIMdOIgVpk8jo5C785NilJJKiByAcKAEgA1A=="}},"id":"prt_1abdcb7f3001LXpllYr8C3jONU","sessionID":"ses_e542352c3ffejapRAmF6phECX)

## Run provenance

| Agent | CLI version | Source revision | Runtime |
|---|---|---|---|
| OASIS | not reported | caea8249938dc86a2016ede312024ab8ec3a9046 | v22.20.0 / linux / x64 |
| Gemini CLI | 0.67.0 | e4505c8def7382ee66d495724cf49a3e297dbb65 | v22.20.0 / linux / x64 |
| Aider | aider 0.86.2 | e4505c8def7382ee66d495724cf49a3e297dbb65 | v22.20.0 / linux / x64 |

## Task coverage

Shared task IDs: clamp-integer, safe-relative-path, taskflow-search.
Verified matched tasks: clamp-integer, safe-relative-path, taskflow-search.

<details><summary>Per-task results</summary>

| Task | Category | Difficulty | OASIS | Gemini CLI | Aider |
|---|---:|---:|---:|---:|---:|
| `clamp-integer` | utility-logic | small | 0% | 0% | 100% |
| `safe-relative-path` | security-boundaries | medium | 0% | 0% | 0% |
| `taskflow-search` | data-structures | medium | 0% | 100% | 0% |

</details>

Raw per-trial JSON files contain verifier output, changed files, and adapter-reported usage. Keep those files with this summary; the summary alone is not a complete audit record.
