# Neural-model strategy

**Date:** 2026-11-15. Status: proposal. Nothing here is implemented unless
the [roadmap](ROADMAP.md) marks it done.

## What is and is not a neural network

OASIS is an agent runtime. It sends prompts to language models, runs tools,
enforces permissions and keeps state. The
[OASIS Neuron Network](../OASIS-NEURON-NETWORK.md) is a supervised graph of
agent runs (parent and child sessions, shared tasks, budgets, lineage). It
has no weights, is not trained and does not learn by gradient descent. The
name is a metaphor for how work spreads through connected agents; this
document does not treat it as a model, and nothing in OASIS should describe
it as one.

The neural networks in an OASIS run are the language models it calls, and
optionally small local models for narrow jobs (embeddings, classification).
There are three different ways to get those models, with very different
costs:

| Path | What it means | Cost | When it is justified |
| --- | --- | --- | --- |
| **Use** | Call an existing hosted or open-weight model through a provider adapter | Inference only | Always the default |
| **Fine-tune** | Further train an existing open-weight model (LoRA/QLoRA or full) on OASIS data | One to a few GPU-days per run, plus data and evaluation work | Only when a measured gap remains after prompt and tool work |
| **Original model** | Design and pre-train a new network from scratch | Large compute budget, a pre-training corpus, a research team | Not justified today; see the criteria below |

## Path 1: use existing models (default)

This is what OASIS does now and will keep doing.

- **Hosted models** through the provider adapters (OpenAI-compatible,
  Anthropic, Responses, and others in `src/provider-registry.mjs`).
- **Local open-weight models** through external servers OASIS already
  supports: Ollama, llama.cpp `llama-server`, LM Studio, vLLM and others
  (`src/hardware.mjs` `LOCAL_SERVERS`, `src/ollama-discovery.mjs`).
  `oasis setup` measures memory and suggests a model size
  (`modelMemoryBudget`, `localModelTier`, `pickInstalledModel`).
- **Routing** between models by task class (`src/task-classifier.mjs`),
  escalation on evidence of failure (`src/escalation.mjs`) and cost policy
  (`src/cost-policy.mjs`).

Proposed improvements, all without training anything:

1. **Capability router.** Replace the rule-only classifier output with a
   small table of measured per-model results on OASIS's own eval tasks
   (`evals/tasks/`, 53 tasks today) and choose the cheapest model that meets
   a quality floor for the task class. Data, not a learned router; RouteLLM
   (Apache-2.0, last push 2024-08) was read as background and is not adopted
   because it is unmaintained and Python-only.
2. **Optional in-process small models**, behind a feature flag and an
   optional dependency, only after a benchmark shows a gain:
   - embeddings for memory and session search (today FTS5 in
     `src/session-search.mjs`), with `sqlite-vec` (Apache-2.0, alpha
     0.1.10, last push 2026-05) for storage;
   - a tiny classifier for routing or prompt-injection screening.
   Candidates: `transformers.js` (Apache-2.0) or `onnxruntime-node` (MIT)
   for ONNX models, `node-llama-cpp` (MIT) for GGUF models. Each adds native
   binaries or large downloads, so none becomes a required dependency.
3. **Recommended open-weight families** for local use, with licences read
   from Hugging Face on 2026-11-15 (details in the
   [ecosystem comparison](OSS-ECOSYSTEM.md#open-weight-models)):
   Qwen3.5 0.8B to 9B and Qwen3.8 27B (Apache-2.0), gpt-oss 20B
   (Apache-2.0), Devstral Small (Apache-2.0), Phi-4 (MIT), SmolLM3 3B
   (Apache-2.0). Models with custom terms (Gemma, Llama, GLM, LFM3) can be
   used by people who accept those terms; OASIS does not bundle or
   redistribute weights.

**Acceptance:** a model is "recommended" in the docs only after it passes
the OASIS harness (`bench/harness/run.mjs`) and the eval tasks at a stated
score on a stated machine, with the run recorded in `bench/results`.

## Path 2: fine-tune an existing model (conditional)

Fine-tuning is worth doing only when all of these hold:

1. A specific, measured failure on OASIS eval tasks persists after prompt,
   tool-description and skill changes (for example a small local model that
   keeps producing malformed tool calls).
2. There is enough clean training data for that failure: at least a few
   thousand verified trajectories, with secrets removed.
3. The base model's licence allows fine-tuning and redistribution of the
   result (Apache-2.0 or MIT families above).
4. There is a held-out eval set that the training data never touched.

Pipeline, reusing what exists:

| Step | Tool | Exists |
| --- | --- | --- |
| Collect trajectories | `oasis sessions export --format openai\|sharegpt`, `oasis batch` (`src/trajectories.mjs`) | Yes |
| Filter to verified runs | completion gates and verification summaries (`src/completion-gates.mjs`, `src/verification-summary.mjs`) | Partly: needs an export filter |
| Remove secrets | secret scanning rules (`src/data/` Gitleaks rules) applied on export | Needs work |
| Train | TRL + PEFT (Apache-2.0), LoRA/QLoRA, outside the npm package | External |
| Evaluate | `bench/harness/run.mjs`, `oasis eval`, external harnesses (Inspect AI, Harbor, SWE-bench) | Yes |
| Serve | export to GGUF, run with llama.cpp or Ollama; or serve with vLLM | External |

The fine-tuning scripts would live in a separate directory or repository
with their own Python dependencies; the npm package stays JavaScript-only.

RL on agent trajectories (verl, OpenRLHF, prime-rl, OpenPipe ART, all
Apache-2.0) comes after supervised fine-tuning has shown a gain, not before.
DSPy (MIT) optimisers can tune prompts and skill text offline against the
same eval set; that changes text, not weights, and is the cheaper first
step.

**Acceptance for a fine-tuned model:** a stated improvement (for example
+10 points tool-call validity, no regression above 2 points on any other
eval group) on the held-out set, reproduced twice, with the training data
card, base-model licence and evaluation log published next to the weights.

## Path 3: an original model (not justified today)

Pre-training a new model would need a corpus, a training stack and a
compute budget far above what OASIS has, and open-weight models in the
sizes OASIS needs already exist under permissive licences. An original
model is reconsidered only if all of these become true:

- a task class central to OASIS where every available open model fails
  after fine-tuning;
- an architecture idea with a measured small-scale result (for example a
  specialised router or verifier under 100M parameters that beats a
  fine-tuned small LLM on the same data);
- funding for compute and evaluation, and people to maintain it.

A small original model for a narrow job (a verifier or router) is the only
plausible first step, and it would still be used by the agent runtime, not
replace it.

## Summary

- Use existing models now; improve routing with measured data.
- Add optional local embeddings or classifiers only after a benchmark.
- Fine-tune only for a measured, persistent gap, with clean data and a
  held-out eval.
- Do not build an original model now.
- Never describe the Neuron Network or any orchestration layer as a neural
  network.
