# OASIS benchmarks

The maintained evaluation, reproducibility rules and five-track measurement contract are documented in [OASIS benchmarks](../docs/BENCHMARKS.md). Frozen task inputs remain under `evals/tasks/`; benchmark-only development artifacts remain under `bench/`.

## Model-free harness benchmark

`bench/harness/` measures the runtime without a model: tool-call recovery, edit application, command safety with approvals off, placeholder and weakened-test guards, commit secret scanning, and context overhead. It runs in seconds and needs no network or API key.

```bash
npm run bench:harness                         # all case sets
node bench/harness/run.mjs --verbose          # list failing cases
node bench/harness/run.mjs --json out.json    # machine-readable report
node bench/harness/run.mjs --check            # CI gate (part of npm run check)
```

| Path | Contents |
| --- | --- |
| `harness/cases/*.mjs` | Development cases (`cases`) and held-out v1 cases (`heldout*`) per track |
| `harness/cases/heldout-v2.mjs` | Held-out v2, written after the v1 fixes |
| `results/harness-baseline.json` | Development set before any harness fix |
| `results/harness-heldout-v1.json` | Held-out v1, first untuned score |
| `results/harness-heldout-v2.json` | Held-out v2, first untuned score |
| `results/harness-latest.json` | Current scores on all sets |

Once a held-out miss is fixed, that set is tuned. Publish the first untuned score as the generalization number, and write a new held-out set before claiming generalization again.
