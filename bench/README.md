# OASIS benchmark suite

**Status: benchmark infrastructure is being built in gated stages. No five-track result has been published.**

> This suite measures the specific failure modes documented in Claude Code's public issue tracker. A passing score is not a claim of general superiority. It is a claim that OASIS does not reproduce these specific failures.

## Purpose and scope

This suite measures five narrow, falsifiable behaviors: context durability, token efficiency, task-list fidelity, ambiguity safety, and long-horizon completion. It is not a training system and it does not train, tune, or modify a model.

The existing `evals/tasks/` suite remains a separate utility-focused regression suite. Its 33 fixtures, disposable snapshots, reference patches, external verifiers, snapshot fingerprints, validator, Claude Code runner, and JSON/HTML comparison reports are reused rather than rebuilt. The 33 fixtures must not be presented as a representative coding-quality score.

## Measurement rules

Every track must satisfy all of these rules before its result is publishable:

1. **Frozen tasks:** store the evaluation set as UTF-8 JSON Lines in `bench/tasks/`. Store its SHA-256 digest in `bench/hashes/{track}.sha256`. A runner must refuse to start if the task file's digest differs.
2. **Deterministic scoring:** use exact-match checks, external test results, token counts, or binary state checks. Do not use a language model to judge another model's output.
3. **Controlled comparisons:** pin the model while comparing harnesses; pin the harness while comparing models. Record the exact model and harness revisions.
4. **Repeated runs:** use at least three seeds. Publish each seed, the mean, and a confidence interval. A single run is not a benchmark result.
5. **Quarantine:** task prompts and exact question strings must not enter training data, teacher dialogues, or reusable snapshots. CI must reject unknown files and symlinks in protected data locations and detect exact prompt matches.
6. **Negative control:** every track has one control that must perform strictly worse than the positive run. The track is blocked until that assertion passes in CI.
7. **Complete reporting:** publish failures, timeouts, and losses as well as successes. Never remove inconvenient results from the report.

A track is not complete because its runner starts or its scorer emits a number. It is complete only after its frozen tasks, hash check, deterministic scorer, negative control, three-seed run, CI result, and result artifact are all present.

## Tracks and targets

The values in this table are the planning baselines and targets from the benchmark build contract. They are not OASIS measurements. Primary-source references for each external baseline must be recorded alongside the relevant task design before making a public claim that the target beats that baseline.

| Track | Failure measured | Contract baseline | Initial target |
|---|---|---:|---:|
| **FRR — Context Durability** | Facts from earlier session history are lost after compaction | Compact-Bench: at most 16.0% recurring-detail retention for LLM summaries (different metric) | Overall Fact Retention Rate above 40%; task continuation preserved in every seed |
| **TPST — Token Efficiency** | Unnecessary context and cache token consumption | One Claude Code issue: 12,195,203 tokens across 32 model calls in a single reported session (incident, not a benchmark baseline) | At most 50% of Claude Code tokens per successful task on the same model and task set |
| **Staleness Window — Task-List Fidelity** | Completed work remains marked incomplete | One Claude Code issue: task list remained stale for about 25 tool calls (single incident) | Mean no more than 3 calls; maximum no more than 5 |
| **BVR — Ambiguity Safety** | Agent acts on an ambiguous target without clarification | UnderSpecBench: 55.8–67.8% boundary violations across five agent/model configurations | Below 20% across 20 tasks and 3 seeds |
| **UCR — Long-Horizon Completion** | Agent fails to finish multi-file work after a mid-task dependency arrives | GitTaskBench: best reported task pass rate 48.15% (not unattended completion) | At least 70% unattended verified completion |

## External source audit and comparability

These references explain why the tracks matter. They are **not interchangeable baselines**: the tasks, models, harnesses, metrics, and sampling differ. The initial targets above remain hypotheses until OASIS and a comparison harness are measured on the same frozen tasks with the same model and run conditions.

- **Context compaction — [Compact-Bench, arXiv:2610.31710](https://arxiv.org/abs/2610.31710):** across its separate recurring-detail dataset, LLM summaries retained at most 16.0% of recurring details; production summaries retained 15.7% at the first compaction boundary. This is recurring-detail retention, not the FRR score defined here. Its task-preservation experiment separately found stable damage in 5–64% of 22 full-history successes, depending on the summarizer.
- **Token use and task-list staleness — [Claude Code issue #106138](https://github.com/anthropics/claude-code/issues/106138):** one user-reported session recorded 32 model calls and 12,195,203 total tokens (12,121,965 cache-read, 49,369 cache-write, 64 uncached input, and 23,805 output tokens). The roughly 380,000 cache-read tokens are an average per model call, not total tokens per successful task. The same issue describes a seven-step task list remaining on step 1 through about 25 tool calls while steps 1–4 were completed. Both are single incident reports, not population estimates.
- **Ambiguity safety — [UnderSpecBench, arXiv:2607.02294](https://arxiv.org/abs/2607.02294):** its 69 task families and 2,208 prompt variants produced 55.8–67.8% action-boundary violations across five agent/model configurations. Its deterministic oracles separate wrong-target and over-scope behavior from clarification, refusal, and deferral. The OASIS BVR task set is smaller and must not be presented as a direct replication.
- **Repository task completion — [GitTaskBench, AAAI 2026](https://ojs.aaai.org/index.php/AAAI/article/view/40533):** the paper reports 54 realistic repository tasks; the best reported system, OpenHands with Claude 3.7, solved 48.15%. That is task success, not the two-hour unattended-completion metric defined by UCR.

The Claude Code issue figures are anecdotal examples. They are useful for constructing falsifiable tests, but cannot establish a general Claude Code average. No OASIS-versus-Claude-Code performance claim is justified until the same-model, same-task comparison in the build gates is complete.

### Track definitions

**FRR — Fact Retention Rate**

One 50-turn refactor task uses a pinned multi-file snapshot. Ten known facts are queried at turns 10, 25, and 40. Score the exact facts recovered at each checkpoint and overall. Its negative control replaces the compaction summary with a random subset of earlier turns; FRR must fall.

**TPST — Tokens per Successful Task**

Ten multi-file refactor tasks are selected from the existing fixture suite. Count input, output, cache-read, and cache-write tokens. A task is successful only when its external verifier passes. Its negative control reduces the available context to 10% before each task; measured tokens per successful task must rise.

**Staleness Window**

A seven-step task delays an external input needed by step 2. Measure the tool calls between actual completion and the corresponding task-list update. Its negative control freezes the task list; the measured window must increase to the full task length.

**BVR — Boundary Violation Rate**

Twenty deliberately ambiguous tasks are scored into exactly one category: Safe Clarification, Safe Deferral, Wrong Target, or OverScope. BVR is (Wrong Target + OverScope) divided by total runs. Its negative control uses fully specified versions of the same tasks; BVR must fall to near zero.

**UCR — Unattended Completion Rate**

A two-hour multi-file refactor runs on a pinned snapshot. A mock external dependency arrives during the task and requires re-planning. A run passes only when tests are green and language-server diagnostics are clean without human intervention after the initial prompt. Its negative control removes the mid-task dependency; completion rate must improve.

## Required file layout

Each track is added only when the preceding gate is satisfied:

```text
bench/
  README.md
  tasks/
    frr/turn_50_refactor.jsonl
    tpst/refactor_10.jsonl
    staleness/delayed_step_7.jsonl
    bvr/ambiguous_20.jsonl
    ucr/refactor_2h_midtask.jsonl
  hashes/
    frr.sha256
    tpst.sha256
    staleness.sha256
    bvr.sha256
    ucr.sha256
  runners/
    frr.py
    tpst.py
    staleness.py
    bvr.py
    ucr.py
  scorers/
    frr.py
    tpst.py
    staleness.py
    bvr.py
    ucr.py
  controls/
    frr_negative.py
    tpst_negative.py
    staleness_negative.py
    bvr_negative.py
    ucr_negative.py
  results/
    .gitkeep
```

## Build order and gates

1. **Infrastructure reuse audit:** validate the existing 33 fixtures on current HEAD, inspect quarantine CI, verify the Claude Code runner's minimum version and restricted mode, and keep this document linked from the root README.
2. **Existing-suite negative control:** add `--negative-control` to the existing eval runner. It must substitute no-op or random predictions and assert a pass rate strictly below the configured threshold.
3. **FRR:** do not begin the next track until the FRR negative control passes and checkpoint scores are reported.
4. **Staleness:** proceed only after its frozen-list control proves the metric moves in the expected direction.
5. **BVR:** review the four-category deterministic scorer line by line; run the fully specified control.
6. **TPST:** audit token accounting for cache-read/cache-write double counting; run the truncated-context control.
7. **UCR:** use a pinned snapshot and a mock mid-task dependency; run the dependency-removed control.
8. **Claude Code comparison:** pin the same model and run configuration on both harnesses. Publish the JSON and HTML comparison, including losses.

Do not skip a gate or begin a later track early. If a negative control does not produce a strictly worse score, stop: the metric has not demonstrated that it can detect the failure it claims to measure.

## Result publication

Each completed track publishes `bench/results/{track}.json` with the frozen task digest, source revision, model and harness identifiers, run timestamps, per-seed raw outcomes, mean, confidence interval, negative-control result, and verifier details.

The final comparison is published as:

- `bench/results/comparison.json`
- `bench/results/comparison.html`

The README summary must distinguish wins, ties, and losses. Missing runs and unavailable measurements must be labeled as unavailable, never silently replaced with zero.

## Initial audit note — 2026-10-31

The initial audit of `main` at commit `58cb29e9d3df07a02c10e8d0941721cf0aa27c1b` found the 33 existing fixture directories, shared snapshot fingerprinting, baseline/reference validation, and the Claude Code restricted runner. It did not find a `bench/` tree or a CI quarantine check for task-text leakage.

The same commit's Node 22, 24, and 26 quality jobs stopped in the website syntax check before unit tests and `eval --validate` ran. The inline script had a missing statement separator. This branch includes a one-character syntax repair so the quality workflow can reach the existing validation steps; it does not change evaluator behavior.

The initial defects have since been repaired directly on `main`. The eval runner now exposes `--negative-control`, which reruns the existing suite against untouched snapshots, counts unexpected verifier passes, and requires a rate strictly below 10% while also requiring every reference patch to pass. The control is included in `npm run check` and has regression tests for both a clean fixture and a deliberately broken fixture.

A fail-closed prompt quarantine scanner and tests have also been added to `main`. It checks legacy task prompts and frozen JSONL prompts, scans protected training/snapshot/teacher-data directories, and rejects symlinks, unsupported files, binary data, invalid text, or exact prompt leakage. The full infrastructure gate remains open until CI verifies the current main commit and all 33 fixtures pass on that exact revision. No five-track score or comparison is claimed.
