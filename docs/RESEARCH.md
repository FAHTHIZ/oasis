# Research record

Projects and techniques reviewed for Oasis, with the decision taken and why.
"Adopted" means the idea or code is in Oasis; "Already equivalent" means Oasis
had a matching implementation when checked; "Rejected" gives the reason.
Last updated November 2026. Feature comparisons with other harnesses are in
[COMPARISON.md](COMPARISON.md).

## Model routing and escalation

| Source | What it does | Decision |
| --- | --- | --- |
| [OpenHands SDK LLM routing](https://docs.openhands.dev/sdk/guides/llm-routing), [classify-and-switch PR](https://github.com/OpenHands/software-agent-sdk/pull/3744) (MIT) | A `RouterLLM` chooses a model per request (for example, multimodal input goes to a vision model); a later change classifies the task and switches models. | Idea adopted: routing lives in the harness, not a proxy. Oasis already routed per task; it adds escalation on agent-loop evidence, which this router does not do. |
| [Aider architect/editor mode](https://aider.chat/2024/09/26/architect.html), [leaderboards](https://aider.chat/docs/leaderboards/) | One model plans and a second applies edits; pairing improved Aider's edit benchmark (for example 80.5% vs 77.4% for Sonnet alone). | Already equivalent in spirit (Oasis has an advisor and planning subagents). The numbers are Aider's, on Aider's benchmark; not claimed for Oasis. |
| [Claude Code model configuration (`opusplan`)](https://code.claude.com/docs/en/model-config) | Opus in plan mode, Sonnet for execution. | Phase-based routing noted; Oasis's evidence-based cascade is a different trigger (struggle, not phase). |
| [Claude advisor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool), [advisor in Claude Code](https://code.claude.com/docs/en/advisor.md), [the advisor strategy](https://claude.com/resources/articles/the-advisor-strategy) | A cheaper executor consults a stronger model when it decides it needs help (Anthropic-only server tool, beta). | Already equivalent: `/advisor MODEL` works on any provider. Limitation shared with Claude: the executor decides when to ask. The cascade adds a harness-side trigger that does not depend on the model noticing its own trouble. |
| [RouteLLM](https://github.com/lm-sys/RouteLLM), [LMSYS post](https://www.lmsys.org/blog/2024-07-01-routellm) (Apache-2.0) | Learned routers trained on chat preference data choose strong vs weak per prompt. | Rejected as a dependency: Python and ML runtime, trained on chat rather than agentic coding, and ignores the run-time evidence Oasis already has. |
| [LiteLLM](https://docs.litellm.ai/) | Proxy with routing, fallbacks and spend tracking. | Rejected as a required layer: Oasis does fallback, quotas and cost policy in-process, and a proxy is another place budgets can be bypassed. Works as an ordinary OpenAI-compatible endpoint. |
| [FreeLLMAPI](https://github.com/Azhan787/FreeLLMAPI), [OmniRoute](https://github.com/cheaper-inference/omniroute) (MIT) | Free-tier aggregators with quota-aware rotation. | Ideas adopted earlier (quota ledger, free-first fallback on credit errors); code not vendored. |

## Repository understanding

| Source | Decision |
| --- | --- |
| Aider repo map (tree-sitter tags + PageRank) | Adopted earlier: `src/repo-map.mjs`. |
| [Tree-sitter](https://tree-sitter.github.io/), [ast-grep](https://ast-grep.github.io/) | Adopted: `src/code-ast.mjs`, `src/ast-grep.mjs`. |
| LSP | Adopted: `src/lsp.mjs`; diagnostics count as verification evidence. |
| [Codebase-Memory](https://ar5iv.labs.arxiv.org/html/2603.27277) (persistent tree-sitter knowledge graph over MCP, call graphs and impact analysis) | Not built in. It can be added as an MCP server today; a persistent call-graph index is a candidate once a benchmark shows that repo-map plus LSP misses impact questions. |
| [Context7](https://github.com/upstash/context7) | Works today as a Claude Code plugin or MCP server (installed from the official marketplace on 8 November 2026). Not bundled: it is a hosted service, and bundling would send queries to a third party by default. |

## Agent harness features

| Source | Decision |
| --- | --- |
| [OpenCode agents and subagents](https://dev.opencode.ai/v1/docs/agents/) | Already equivalent: custom agents with their own prompts, models and tool access; `@` mentions. |
| [Cline Plan & Act](https://docs.cline.bot/core-workflows/plan-and-act) | Already equivalent: plan mode is read-only and keeps context into execution. |
| [Codex CLI approval modes](https://help.openai.com/en/articles/11096431) | Already equivalent: permission modes plus a sandbox. |
| [Gemini CLI checkpointing](https://google-gemini.github.io/gemini-cli/docs/cli/checkpointing.html) | Already equivalent: file checkpoints before edits, `/rewind` and `/rollback`. |
| Goose extensions | Already equivalent through MCP. |

## How decisions are made

A dependency is added only for a measured advantage over what Oasis already
has, with an acceptable licence, active maintenance and a footprint that
still runs on a 2-CPU machine with no GPU. Popularity alone is not a reason.
