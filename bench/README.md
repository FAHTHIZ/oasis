# OASIS benchmarks

The benchmark inventory, validity rules, limitations, and publication gates are documented in [OASIS benchmarks](../docs/BENCHMARKS.md). The repository contains several different measurements; do not combine them into one score.

## Model-free harness microbenchmarks

`bench/harness/` feeds deterministic synthetic inputs into selected OASIS runtime helpers and safety checks. It measures tool-call recovery, edit matching, command policy outcomes, placeholder detection, weakened-test detection, secret scanning, and one scripted context/startup profile. It does **not** run an LLM or measure coding-task success.

```bash
npm run bench:harness
node bench/harness/run.mjs --verbose
node bench/harness/run.mjs --json out.json
node bench/harness/run.mjs --check
```

| Path | Contents |
| --- | --- |
| `harness/cases/*.mjs` | Development cases and held-out v1 cases |
| `harness/cases/heldout-v2.mjs` | Held-out v2, written after v1 fixes |
| `results/harness-baseline.json` | Historical development-set baseline |
| `results/harness-heldout-v1.json` | First untuned v1 observation (now tuned) |
| `results/harness-heldout-v2.json` | First untuned v2 observation (now tuned) |
| `results/harness-2026-11-01.json` | Archived report from 2026-11-01 (superseded) |
| `results/harness-2026-11-05.json` | Latest full report: all three sets, context overhead and startup, at source revision `579145b` (Node 22.21, 2-CPU Linux) |

A new local `--json` report measures current code. CI uploads a fresh Node-version-specific report artifact. Once a held-out set has informed a fix, it is no longer unseen; keep its first score as history and add a new untouched set before claiming generalization.

## Agent task fixtures and live comparisons

The deterministic agent fixtures are under `evals/tasks/`. `node src/cli.mjs eval --validate` checks evaluator integrity (untouched snapshot fails; reference patch passes). It does not call a model and does not establish an agent pass rate.

```bash
node src/cli.mjs eval --validate
node src/cli.mjs eval --negative-control
node src/cli.mjs eval --task taskflow-dependencies --trials 1 --yes
```

`npm run bench:live -- --yes` runs OASIS and available external coding-agent CLIs on disposable fixture copies and applies the task verifiers. It requires configured CLIs/model access. Use `--trials 3` or more for exploratory repeats. A task enters the headline score only when every completed agent has the same valid SHA-256 task fingerprint, consistent classification metadata, and the requested number of distinct trials. Agent tool surfaces, permissions, and sandbox policies still differ. A shared gateway is not proof that all clients received the same underlying model. Treat this as a configured-product comparison unless gateway logs and actual model versions establish otherwise.

```bash
npm run bench:live -- --agents oasis,claude --router http://localhost:20128/v1 --model MODEL_ID --trials 3 --yes
```

## Search retrieval diagnostic

`npm run bench:search -- --trials 3 --out search-report.json` compares the pre-federation search path with federated search on the fixed 10-query set in `evals/search/queries.json`. It measures expected-domain hits, reciprocal rank, result counts, unique domains, provider errors, and sequential latency. Call order alternates to reduce one source of order bias. It does **not** evaluate factual correctness, answer quality, completeness, or research quality. The default is one trial per query; one run is a smoke test, not a stable estimate.

## Installed CLI launch-time measurement

`npm run bench:startup -- --runs 5` measures repeated launches of the installed `oasis --version` command. It is a local CLI launch-time diagnostic, not model-request latency, interactive response time, or a controlled cold-start benchmark. The script reports every sample plus median, minimum, and maximum.

## Future five-track protocol

The FRR, TPST, task-list staleness, ambiguity-safety, and unattended-completion tracks in `docs/BENCHMARKS.md` are a **design protocol only**. Their frozen task files, hashes, runners, scorers, negative controls, and published results do not yet exist. Do not present target values as OASIS measurements.
