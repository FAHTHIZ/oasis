# Open-source ecosystem comparison

**Date:** 2026-11-15. Licence, stars and last push were read from the GitHub
API on that date. "Source read" means the repository was cloned and the named
files were read for this report; "Docs and metadata" means only the licence,
activity and published documentation were checked, and the verdict should be
read as provisional.

Verdicts use four words:

- **Adopt:** use the project (as a dependency or a supported integration).
- **Adapt:** take the idea, implement it in OASIS's own code, credit the source.
- **Replace:** a project could replace an OASIS subsystem. None qualifies today.
- **Build:** OASIS needs it and no project fits; write it.
- **Reject:** not worth the cost, or the licence does not fit.

The rule from [RESEARCH.md](../RESEARCH.md) applies: a dependency only for a
measured advantage, with an acceptable licence, active maintenance and a
footprint that still runs on a 2-CPU machine with no GPU.

## Agent runtimes and frameworks

| Project | Licence | Lang | Stars / last push | Checked | What is worth taking | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | MIT | Python | 263k / 2026-11-15 | Source read | Prompt-surface invariant, narrow-waist rule, frozen memory snapshot, delegation roles | Adapt ([report](HERMES-AGENT.md)) |
| [OpenHands software-agent-sdk](https://github.com/OpenHands/software-agent-sdk) | MIT | Python | 1.4k / 2026-11-15 | Source read: `openhands/sdk/critic/`, `security/`, `context/condenser/` | Critic with iterative refinement (`IterativeRefinementConfig`: retry until a critic score passes a threshold, bounded iterations); pipeline condensers; an ensemble of security analyzers | Adapt the critic loop into OASIS's verification gate; reject the runtime |
| [OpenAI Agents SDK (JS)](https://github.com/openai/openai-agents-js) | MIT | TS | 4.0k / 2026-11-15 | Source read: `agents-core/src/guardrail.ts`, `toolGuardrail.ts`, `runState.ts` | Input/output guardrails with a tripwire that halts the run; tool input/output guardrails; serializable `RunState` that pauses on an approval and resumes later | Adapt: serializable pending-approval state for headless and gateway runs |
| [LangGraph.js](https://github.com/langchain-ai/langgraphjs) | MIT | TS | 3.4k / 2026-11-14 | Source read: `libs/checkpoint/src/base.ts`, `libs/checkpoint-sqlite` | Checkpointer contract: `put`, `putWrites` for pending writes of a step, `getTuple`, `list`, parent pointers for time travel | Adapt the pending-writes idea for the network scheduler. Reject as a dependency: peer-depends on `@langchain/core`, SQLite saver needs native `better-sqlite3` (OASIS uses built-in `node:sqlite`) |
| [Mastra](https://github.com/mastra-ai/mastra) | Apache-2.0, except `ee/` (Mastra Enterprise License) | TS | 29.5k / 2026-11-15 | Source read: `packages/memory/src/processors/observational-memory/ARCHITECTURE.md` | Observational memory: an observer model turns messages into observations, a reflector compresses them, buffering runs in the background ahead of a cursor, with a written invariant for when nothing can be lost | Adapt the observer/reflector split and its invariant. Reject as a dependency: large framework, mixed licence tree |
| [Letta Code](https://github.com/letta-ai/letta-code) (successor of Letta/MemGPT) | Apache-2.0 | TS | (letta 25k) / 2026-11-15 | Source read: `letta-code/src/backend/local/initial-memory.ts`, `letta-code/src/reflection-settings.ts` | Memory as Markdown files with front matter ("MemFS"); reflection triggered by step count or a compaction event, with auto or explicit merge | Adapt: compaction-triggered reflection. OASIS's file memory is already equivalent |
| [mem0](https://github.com/mem0ai/mem0) | Apache-2.0 | Python, TS | 69k / 2026-11-06 | Source read: `mem0/memory/main.py` (`_add_to_vector_store`) | Phased pipeline: gather recent context, retrieve the top 10 existing memories, one extraction call, and map memory UUIDs to small integers so the model cannot invent IDs | Adapt the integer-ID trick for any model-edited memory list. Reject as a dependency: needs an embedding model and vector store by default |
| [Codex CLI](https://github.com/openai/codex) | Apache-2.0 | Rust | 135k / 2026-11-15 | Docs and metadata (interop already built) | App Server protocol, exec JSON | Already integrated (`src/codex-app-server.mjs`, `src/codex-exec-json.mjs`) |
| [OpenCode](https://github.com/anomalyco/opencode) | MIT | TS | 227k / 2026-11-15 | Docs and metadata | Agents and subagents config | Already equivalent ([COMPARISON.md](../COMPARISON.md)) |
| [Goose](https://github.com/aaif-goose/goose) | Apache-2.0 | Rust | 57k / 2026-11-14 | Docs and metadata | Recipes, hints files | Already integrated (`src/goose-recipes.mjs`) |
| [Google ADK (JS)](https://github.com/google/adk-js) | Apache-2.0 | TS | 1.5k / 2026-11-14 | Docs and metadata | Agent and session abstractions | Reject: overlaps OASIS's runtime |
| [Microsoft Agent Framework](https://github.com/microsoft/agent-framework) | MIT | Python, .NET | 14.7k / 2026-11-15 | Docs and metadata | Successor to AutoGen and Semantic Kernel agents | Reject: different ecosystem |
| [AutoGen](https://github.com/microsoft/autogen) | Code MIT (`LICENSE-CODE`), docs CC-BY-4.0 | Python | 62k / 2026-11-12 | Metadata | Superseded by Agent Framework | Reject |
| [CrewAI](https://github.com/crewAIInc/crewAI) | MIT | Python | 61k / 2026-11-15 | Metadata | Role-based crews | Reject: OASIS teams cover it |
| [smolagents](https://github.com/huggingface/smolagents) | Apache-2.0 | Python | 30k / 2026-11-15 | Metadata | Code agents | Already equivalent (`execute_code`) |
| [Pydantic AI](https://github.com/pydantic/pydantic-ai) | MIT | Python | 21k / 2026-11-15 | Metadata | Typed tools and outputs | Reject: Python |

## Model access and inference

| Project | Licence | Checked | Role for OASIS | Verdict |
| --- | --- | --- | --- | --- |
| [Vercel AI SDK](https://github.com/vercel/ai) | Apache-2.0 | Metadata | Provider abstraction | Reject: OASIS's own transport covers three wire protocols with tests (`docs/architecture/provider-transport.md`); replacing it gains nothing measured |
| [LiteLLM](https://github.com/BerriAI/litellm) | MIT except `litellm/enterprise/` | Metadata | Proxy | Already decided: works as an endpoint, not required ([RESEARCH.md](../RESEARCH.md)) |
| [Ollama](https://github.com/ollama/ollama) | MIT | Metadata, integration tests | Local server | Adopt as a supported external server (already: `src/ollama-discovery.mjs`, `src/local-context.mjs`) |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | MIT | Metadata | Local server, GGUF, grammars | Adopt as a supported external server (already in provider presets) |
| [node-llama-cpp](https://github.com/withcatai/node-llama-cpp) | MIT | Source read: `package.json` | In-process llama.cpp for Node with JSON-schema grammars and prebuilt binaries | Candidate for an optional in-process local model (no separate server). 29 runtime dependencies plus `cmake-js` for source builds; must stay optional, like `sharp` |
| [vLLM](https://github.com/vllm-project/vllm), [SGLang](https://github.com/sgl-project/sglang) | Apache-2.0 | Metadata | GPU serving | Adopt as external servers only |
| [mlx-lm](https://github.com/ml-explore/mlx-lm) | MIT | Metadata | Apple Silicon serving and LoRA | Adopt as an external server and fine-tuning path on macOS |
| [transformers.js](https://github.com/huggingface/transformers.js), [onnxruntime](https://github.com/microsoft/onnxruntime) | Apache-2.0, MIT | Metadata | Small in-process models (embeddings, classifiers, rerankers) in Node | Candidate for the local embedding and router models in [MODEL-STRATEGY.md](MODEL-STRATEGY.md); optional dependency only |
| [RouteLLM](https://github.com/lm-sys/RouteLLM) | Apache-2.0 | Metadata | Learned router | Already rejected; no push since 2024-08 |

## Memory and retrieval storage

| Project | Licence | Checked | Verdict |
| --- | --- | --- | --- |
| `node:sqlite` (built into Node 22) | MIT (Node) | Used by `src/session-search.mjs` (FTS5 BM25) | Adopt: already the session index; extend to memory and the network ledger |
| [sqlite-vec](https://github.com/asg017/sqlite-vec) | Apache-2.0 | Source read: `VERSION` is `0.1.10-alpha.4`, last push 2026-05-18 | Candidate for vector search inside the same SQLite file. Pre-1.0 and quiet for six months: optional only, behind an interface, with brute-force cosine as the fallback |
| [LanceDB](https://github.com/lancedb/lancedb) | Apache-2.0 | Metadata | Reject for now: second storage engine |
| [Graphiti](https://github.com/getzep/graphiti), [Cognee](https://github.com/topoteretes/cognee) | Apache-2.0 | Metadata | Reject as dependencies (Python, graph DB); temporal-fact idea noted |
| [Honcho](https://github.com/plastic-labs/honcho) | AGPL-3.0 | Metadata | Reject: AGPL network clause does not fit an Apache-2.0 product that runs servers |

## Durable execution and orchestration

| Project | Licence | Checked | Verdict |
| --- | --- | --- | --- |
| [Temporal](https://github.com/temporalio/temporal) | MIT | Metadata | Reject: a server cluster for a local-first tool |
| [DBOS Transact TS](https://github.com/dbos-inc/dbos-transact-ts) | MIT | Metadata | Idea adapted: workflow steps recorded in a database so a restart resumes from the last completed step. Reject as a dependency (Postgres-first) |
| [Restate](https://github.com/restatedev/restate) | BSL-1.1 | Licence read | Reject: source-available, not open source |
| [Inngest](https://github.com/inngest/inngest) | SSPL with a delayed Apache-2.0 future licence | Licence read | Reject: SSPL |

## Protocols

| Protocol | Licence | Status in OASIS | Verdict |
| --- | --- | --- | --- |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | Moving from MIT to Apache-2.0 (new code Apache-2.0; unconsented older code stays MIT) | Client and server in use | Adopt (already) |
| [Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol) | Apache-2.0 | `src/acp.mjs` | Adopt (already) |
| [A2A](https://github.com/a2aproject/A2A) | Apache-2.0 | Not implemented | Adapt later: expose an OASIS network as one A2A agent once the network API is stable. Not before |

## Training, fine-tuning and evaluation

| Project | Licence | Checked | Verdict |
| --- | --- | --- | --- |
| [TRL](https://github.com/huggingface/trl), [PEFT](https://github.com/huggingface/peft) | Apache-2.0 | Metadata | Adopt as the offline fine-tuning toolchain (outside the npm package) |
| [Unsloth](https://github.com/unslothai/unsloth), [Axolotl](https://github.com/axolotl-ai-cloud/axolotl), [LlamaFactory](https://github.com/hiyouga/LlamaFactory) | Apache-2.0 | Metadata | Alternatives to TRL scripts; pick one when the first fine-tune is run, not before |
| [torchtune](https://github.com/meta-pytorch/torchtune) | BSD-3-Clause | Metadata | Alternative |
| [verl](https://github.com/verl-project/verl), [OpenRLHF](https://github.com/OpenRLHF/OpenRLHF), [prime-rl](https://github.com/PrimeIntellect-ai/prime-rl), [OpenPipe ART](https://github.com/OpenPipe/ART) | Apache-2.0 | Metadata | RL on agent trajectories; only after supervised fine-tuning shows a gain |
| [Atropos](https://github.com/NousResearch/atropos) | MIT | Metadata: archived 2026-07 | Reject: archived |
| [DSPy](https://github.com/stanfordnlp/dspy) | MIT | Source read: `dspy/teleprompt/` (MIPROv2, GEPA, SIMBA, BootstrapFinetune, GRPO) | Adapt: optimise OASIS prompts and skills against its own eval harness offline. Reject as a runtime dependency (Python) |
| [Inspect AI](https://github.com/UKGovernmentBEIS/inspect_ai), [Harbor](https://github.com/harbor-framework/harbor), [SWE-bench](https://github.com/SWE-bench/SWE-bench) | MIT, Apache-2.0, MIT | Metadata | Adopt as external benchmark harnesses; OASIS's own harness (`bench/harness/run.mjs`) stays the regression gate |

## Sandboxing

| Project | Licence | Status | Verdict |
| --- | --- | --- | --- |
| [Anthropic sandbox-runtime](https://github.com/anthropics/sandbox-runtime) | Apache-2.0 | Dependency (`src/sandbox-runtime.mjs`) | Adopt (already) |
| [E2B](https://github.com/e2b-dev/E2B) | Apache-2.0 | Not integrated | Reject as a default (hosted service); possible remote backend later |

## Open-weight models

Licences read from Hugging Face model metadata on 2026-11-15:

| Model family | Licence | Sizes relevant to OASIS |
| --- | --- | --- |
| Qwen3.5 (Feb 2026), Qwen3.8 (Aug 2026) | Apache-2.0 | 0.8B, 2B, 4B, 9B dense; 35B-A3B MoE; 27B |
| DeepSeek-V4 Flash / Pro | MIT | Large MoE; hosted or multi-GPU only |
| gpt-oss 20B / 120B | Apache-2.0 | 20B runs on a 16 GB GPU or a large-RAM CPU box |
| Hermes 4 / Arete (Nous Research) | Apache-2.0 | 14B, 27B, 36B |
| SmolLM3 | Apache-2.0 | 3B |
| Phi-4 | MIT | 14B |
| Devstral Small | Apache-2.0 | 24B |
| GLM-5.x, LFM3 | "other" (custom licences) | Read the terms before redistributing or fine-tuning |
| Gemma 3, Llama 3.x | Gemma terms, Llama community licence | Usable with conditions; not "open source" in the OSI sense |

## Summary of decisions

- **Replace:** nothing. No project offers a measured gain over an OASIS
  subsystem large enough to justify a migration.
- **Adopt:** what is already integrated (MCP, ACP, sandbox-runtime, Ollama,
  llama.cpp, external servers), `node:sqlite` as the single local store,
  TRL/PEFT for offline fine-tuning, external benchmark harnesses.
- **Adapt:** Hermes prompt-surface test and delegation roles; OpenHands
  critic refinement; Agents SDK serializable approval state; LangGraph
  pending writes; Mastra observer/reflector memory with its invariant; Letta
  compaction-triggered reflection; mem0 integer IDs; DSPy offline prompt
  optimisation.
- **Build:** the network scheduler and ledger, the capability router, the
  skill script audit, and the evaluation sets in [ROADMAP.md](ROADMAP.md).
- **Optional dependencies to evaluate with a benchmark first:**
  `sqlite-vec`, `node-llama-cpp`, `transformers.js` or `onnxruntime-node`.
