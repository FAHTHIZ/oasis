# Dependency and licensing assessment

**Date:** 2026-11-15. Licences were read from the GitHub API, the npm
registry and Hugging Face model metadata on that date. This is an
engineering assessment, not legal advice.

## Current state

OASIS is Apache-2.0 ([LICENSE](../../LICENSE)). The licences of its
production and optional npm dependencies, vendored assets and the desktop
app are listed in [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md).
`test/third-party-licenses.test.mjs` fails the suite when a production
dependency has a licence outside the permissive allowlist and is not in its
reviewed list.

Items that already need care (details in the notices file):

- `elkjs` (EPL-2.0), unmodified, through `beautiful-mermaid`.
- `sharp` prebuilt libvips binaries (LGPL-3.0-or-later), optional and
  dynamically linked.
- `dompurify` (MPL-2.0 OR Apache-2.0) and `node-forge`
  (BSD-3-Clause OR GPL-2.0), used under the permissive option.
- The MCP TypeScript SDK repository reports `NOASSERTION` on GitHub because
  it is moving from MIT to Apache-2.0; the `@modelcontextprotocol/client`,
  `server` and `ext-tasks` versions OASIS installs declare Apache-2.0 in
  their `package.json`, which the licence test checks.

## Rules for any new dependency

1. A measured advantage over the current code (benchmark or a removed
   maintenance burden), stated in the pull request.
2. Licence on the allowlist: MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD,
   BlueOak-1.0.0, or reviewed and recorded in the test.
3. Maintained: a release or commit within the last 12 months, unless the
   package is small and complete.
4. Runs on a 2-CPU machine without a GPU, or is optional.
5. Native binaries or model downloads only as optional dependencies, with
   OASIS working without them.

## Candidates from the research

| Candidate | Licence | Use | Decision |
| --- | --- | --- | --- |
| `sqlite-vec` | Apache-2.0 or MIT (both licence files in the repository) | Vector search inside the existing `node:sqlite` store | Optional, after a retrieval benchmark on `evals/memory-retrieval/`. Note: alpha, last push 2026-05 |
| `transformers.js` | Apache-2.0 | Local embeddings or classifiers (ONNX) | Optional, after a benchmark |
| `onnxruntime-node` | MIT | Same, lower level | Optional alternative to `transformers.js` |
| `node-llama-cpp` | MIT | In-process GGUF models | Optional; external `llama-server` and Ollama remain the default |
| TRL, PEFT | Apache-2.0 | Offline fine-tuning | Outside the npm package |
| DSPy | MIT | Offline prompt optimisation | Outside the npm package |
| Inspect AI, Harbor, SWE-bench | MIT, Apache-2.0, MIT | External benchmarks | Outside the npm package |
| A2A protocol | Apache-2.0 | Agent-to-agent interop | Later, only with a concrete user need |
| LangGraph.js, OpenAI Agents JS, Letta, mem0, Mastra, OpenHands SDK | MIT / Apache-2.0 (Mastra core) | Ideas | Adapt ideas with credit; no runtime dependency (they would duplicate the OASIS loop) |

## Rejected for licence reasons

| Project | Licence | Reason |
| --- | --- | --- |
| Honcho | AGPL-3.0 | Network copyleft would reach OASIS users who host it |
| Restate | BSL-1.1 | Source-available, not open source |
| Inngest | SSPL (server) | Not OSI-approved |
| Mastra `ee/` | Mastra enterprise licence | Core is Apache-2.0; the enterprise directory is not open source. Only Apache-2.0 ideas were read |
| LiteLLM `enterprise/` | Commercial licence | The MIT part is fine but OASIS has its own provider adapters |

## Model weights

OASIS does not bundle or redistribute model weights. Users download models
through their own server (Ollama, llama.cpp, vLLM). The docs only recommend
models under Apache-2.0 or MIT (Qwen3.5, Qwen3.8, gpt-oss, Devstral Small,
Phi-4, SmolLM3, DeepSeek-V4). Models under custom terms (Gemma, Llama, GLM,
LFM3) are supported through the same adapters but are not recommended by
default, and their terms must be read before fine-tuning or redistributing
a derivative.

## Attribution for adapted ideas

When an idea from another project is implemented in OASIS code, the commit
and the relevant doc name the source project and licence (for example
"prompt-surface snapshot test, adapted from Hermes Agent, MIT"). No code is
copied without keeping its licence header; MIT and Apache-2.0 code copied
verbatim also gets an entry in THIRD-PARTY-NOTICES.md.
