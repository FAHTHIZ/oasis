# OASIS benchmark suite

This directory contains a falsifiable measurement suite for five narrowly defined agent failure modes. It reuses the existing `evals/` fixture and runner infrastructure; it does not replace that infrastructure.

> **"This suite measures the specific failure modes documented in Claude Code's public issue tracker. A passing score is not a claim of general superiority. It is a claim that OASIS does not reproduce these specific failures."**

## Scope and interpretation

The five tracks are independent measurements. Results must include failures as well as successes. A missing result is not a pass, and an unverified run must never be presented as a measured result.

| Track | Measurement | Reported baseline in build contract | Initial target |
|---|---|---:|---:|
| FRR — Context Durability | Facts recovered at turns 10, 25 and 40 | Summary retention reported at up to 16.0% for recurring details | Overall FRR > 40%; continuation preserved in every seed |
| Staleness Window — Task-List Fidelity | Tool calls between actual completion and task-list update | Approximately 25 tool calls | Mean ≤ 3; maximum ≤ 5 |
| BVR — Ambiguity Safety | Wrong-target and over-scope runs / all runs | 55.8–67.8% reported for underspecified tasks | < 20% |
| TPST — Token Efficiency | Total input, output, cache-read and cache-write tokens / successful tasks | 50M tokens reported for 135 tasks in one comparison | ≤ 50% of Claude Code on the same model |
| UCR — Long-Horizon Completion | Unattended runs reaching verified green state / all runs | Below 60% reported for collaborative repository tasks | ≥ 70% |

The baseline figures above are claims supplied by the benchmark build contract. They are context, not results reproduced or independently verified by this repository. The benchmark must cite and pin the primary source material before publishing comparative claims.

## Non-negotiable methodology

1. Freeze each task set as JSONL and store its SHA-256 digest in `bench/hashes/{track}.sha256`. A runner must refuse to run if the digest differs.
2. Use deterministic scoring only: exact facts, external verifier results, instrumented state, or binary outcomes. No model judges.
3. Hold the model fixed when comparing harnesses; hold the harness fixed when comparing models.
4. Run at least three seeds and report the mean and a confidence interval. Preserve per-seed outcomes.
5. Keep benchmark task strings out of training, snapshots and teacher-dialogue material. Quarantine checks must fail closed.
6. Each track has exactly one negative control. It must produce a strictly worse metric than its positive run and must run in CI.
7. Publish losses and inconclusive results alongside wins.

## Build sequence and gates

Build in this order. Do not start the next track until the current track's negative control passes in CI.

1. Infrastructure reuse audit and this README.
2. Negative control for the existing 33-fixture utility suite.
3. FRR.
4. Staleness Window.
5. BVR.
6. TPST.
7. UCR.
8. Same-model Claude Code head-to-head and publication of all outcomes.

The 33 existing fixtures remain a utility-focused regression/smoke suite. They are not a representative coding-quality benchmark and must not be described as one.

## Current verification status

**No benchmark track is complete. No current-HEAD fixture pass is claimed here.** The latest inspected repository commit is `58cb29e9d3df07a02c10e8d0941721cf0aa27c1b`. The repository's status audit explicitly says that no features were verified on its then-current HEAD; a fresh run against the exact commit used for this benchmark is required.

Source inspection confirms that the existing CLI exposes `oasis eval --validate`, and that the existing Claude Code runner requests restricted mode and rejects versions older than v2.1.248. This is source inspection, not a successful runtime test. The quarantine workflow and current-HEAD fixture results remain to be verified before the infrastructure audit gate can close.

## Result publication

Each completed track publishes `bench/results/{track}.json` with:
- task-set hash and source revision;
- model and harness versions/configuration;
- all seeds and per-task outcomes;
- deterministic scoring details;
- mean and confidence interval;
- positive and negative-control outcomes;
- explicit limitations and any failed target.

The final comparison belongs in `bench/results/comparison.json` and `bench/results/comparison.html`. Never omit a losing track or silently drop a failed task.

## Repository boundaries

- Do not add training or model code here.
- Do not alter or duplicate the existing `evals/tasks/` fixture system.
- Do not claim broad capability, general superiority, or parity from these five tracks.
- Do not mark a track complete until its frozen-set hash, deterministic scorer, three-seed report and CI negative control all pass.
