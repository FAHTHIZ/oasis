# Cross-agent task benchmark — 2026-11-14

OASIS 1.3.0 · 1 verified matched tasks × 1 requested trial(s) · shared endpoint `api.kilo.ai (recorded)`.

Headline pass rate is a macro-average of per-task pass rates. A task contributes only when every completed agent has exactly the requested number of distinct trials, complete matching SHA-256 task fingerprints, and matching category/difficulty metadata.

| Agent | Requested model | CLI-reported model | Pass rate | Passed trials | Median trial time | Tokens | Total reported cost |
|---|---|---|---:|---:|---:|---:|---:|
| OASIS 1.3.0 (nvidia/nemotron-3-ultra-550b-a55b:free) | nvidia/nemotron-3-ultra-550b-a55b:free | nvidia/nemotron-3-ultra-550b-a55b:free | 0% | 0/1 | 266.8 s | 120960 | $0.0000 |
| Claude Code 2.1.325 (Claude Code) (nvidia/nemotron-3-ultra-550b-a55b:free) | nvidia/nemotron-3-ultra-550b-a55b:free | nvidia/nemotron-3-ultra-550b-a55b:free | 0% | 0/1 | 270.5 s | 36240 | $0.2056 |
| Codex CLI codex-cli 0.169.0 (nvidia/nemotron-3-ultra-550b-a55b:free) | nvidia/nemotron-3-ultra-550b-a55b:free | nvidia/nemotron-3-ultra-550b-a55b:free | 0% | 0/1 | 522.9 s | 304276 | n/a |
| OpenCode 1.19.5 (bench/nvidia/nemotron-3-ultra-550b-a55b:free) | bench/nvidia/nemotron-3-ultra-550b-a55b:free | bench/nvidia/nemotron-3-ultra-550b-a55b:free | 0% | 0/1 | 263.7 s | 48713 | $0.0000 |

## Gateway record

Same model verified: every scored agent's calls were served by `nvidia/nemotron-3-ultra-550b-a55b:free`, as reported by the upstream.

| Agent | Calls | Failed calls | Served model(s) | Provider(s) | Input tokens | Output tokens |
|---|---:|---:|---|---|---:|---:|
| oasis | 31 | 0 | nvidia/nemotron-3-ultra-550b-a55b:free ×31 | Nvidia ×31 | 608994 | 5509 |
| claude | 25 | 8 | nvidia/nemotron-3-ultra-550b-a55b:free ×17 | none reported | 69400 | 5512 |
| codex | 29 | 1 | nvidia/nemotron-3-ultra-550b-a55b:free ×28 | none reported | 339454 | 4100 |
| opencode | 11 | 0 | nvidia/nemotron-3-ultra-550b-a55b:free ×11 | Nvidia ×11 | 130117 | 2768 |

## Interpretation limits

- The run stopped early: the upstream quota ran out during Codex CLI · safe-relative-path (HTTP 429 that the provider marks as not retryable). 9 agent/task unit(s) did not run.
- Agent adapters do not use identical tool surfaces, approval modes, or sandbox policies. This is a configured-product comparison, not an isolated measurement of harness code.
- Token and cost fields are adapter-reported usage. Cost may be absent or calculated differently by providers; it is not a normalized billing audit.
- Only 1 task(s) have complete, identical SHA-256 fingerprints and the requested number of trials across all completed agents; the guide targets at least 50 representative tasks.
- Only 1 trial(s) per task were requested. One trial is a smoke test; three trials are a minimum diagnostic repeat, not a confidence interval or significance test.
- No verified matched task is labeled large; this run does not test larger repository-level work.
- 1 task(s) were not run by every completed agent and are not scored: safe-relative-path. Their outcomes are listed under Task coverage.
- Every scored agent was served model nvidia/nemotron-3-ultra-550b-a55b:free, but the gateway could not confirm one upstream provider for all of them (missing or different provider fields); serving stacks can differ in quantization and limits.
- The selected agents do not all have one identical, explicitly requested model ID.

## Run provenance

| Agent | CLI version | Source revision | Runtime |
|---|---|---|---|
| OASIS | 1.3.0 | 5743ce4d1b348ada5bad2bfe74dabb304bac2f5f (HEAD moved to dc02de567c5aab53d1c2830e4e7f85ae0b8bb6a7 during the run; the loaded code is the first revision) | v22.21.1 / linux / x64 |
| Claude Code | 2.1.325 (Claude Code) | 5743ce4d1b348ada5bad2bfe74dabb304bac2f5f (HEAD moved to cab908ced457dad70f25b232e4baed2c710de314 during the run; the loaded code is the first revision) | v22.21.1 / linux / x64 |
| Codex CLI | codex-cli 0.169.0 | 5743ce4d1b348ada5bad2bfe74dabb304bac2f5f (HEAD moved to cab908ced457dad70f25b232e4baed2c710de314 during the run; the loaded code is the first revision) | v22.21.1 / linux / x64 |
| OpenCode | 1.19.5 | 5743ce4d1b348ada5bad2bfe74dabb304bac2f5f (HEAD moved to 5922de4893e1c4271215bbe93168af6d7e8f8499 during the run; the loaded code is the first revision) | v22.21.1 / linux / x64 |

## Task coverage

Shared task IDs: taskflow-priority-sort.
Verified matched tasks: taskflow-priority-sort.

Not every agent ran these tasks, so they are not scored:

| Task | OASIS | Claude Code | Codex CLI | OpenCode |
|---|---|---|---|---|
| `safe-relative-path` | passed 1/1 | passed 1/1 | failed 0/1 (upstream HTTP 429) | not run |

<details><summary>Per-task results</summary>

| Task | Category | Difficulty | OASIS | Claude Code | Codex CLI | OpenCode |
|---|---:|---:|---:|---:|---:|---:|
| `taskflow-priority-sort` | data-structures | small | 0% | 0% | 0% | 0% |

</details>

Raw per-trial JSON files contain verifier output, changed files, and adapter-reported usage. Keep those files with this summary; the summary alone is not a complete audit record.
