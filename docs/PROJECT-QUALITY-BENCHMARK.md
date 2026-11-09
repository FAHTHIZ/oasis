# OASIS repository-quality benchmark

**Audit date:** 2026-11-07  
**Audited branch:** `main`  
**Audit commit:** [`20f44b897f5f9e1ad574df483d94d4a92a52c77b`](https://github.com/FAHTHIZ/oasis/commit/20f44b897f5f9e1ad574df483d94d4a92a52c77b)  
**Purpose:** compare repository presentation, developer experience and engineering practice—not model intelligence or coding-task success.

## Executive result

OASIS already has a substantial engineering foundation and a recognizable visual identity. At this audit head, the repository contains 1,206 tracked files: 219 under `src/`, 411 test files, 384 evaluation fixtures, 29 benchmark files, 26 browser-app files, 26 skills, 17 GitHub automation files, 16 brand/demo assets and 9 maintained technical documents.

The strongest gaps are not a lack of features or badges. They are **release/distribution truth, product walkthrough coverage across all interfaces, documentation discoverability, and controlled external coding-agent evaluations**. The README now includes a real CLI model run; browser and desktop walkthroughs remain to be captured.

The headline assessment is:

- **Engineering foundation:** strong for a solo-maintained project, based on visible repository structure and CI configuration.
- **Repository presentation:** good brand and core README; several avoidable trust and navigation gaps remain.
- **Product proof:** materially improved by the README's unscripted `gpt-oss-20b` CLI recording, GIF/MP4 and raw terminal cast; the web app now has screenshots from the browser e2e run.
- **Competitive coding quality:** not established by this audit. Repository quality cannot show that OASIS completes more coding tasks than Codex, Claude Code, OpenCode or other agents.

This is a practical gap analysis, not a universal quality ranking.

## Scope and method

### Reference set

The broad discovery set is the third-party [AI Agents Top 100 index](https://github.com/sifted-network/sifted-awesome-ai-agents/blob/main/top100/AI%20Agents.md), whose table was retrieved on November 7, 2026 and whose entries carry source-reported update dates around November 6. It contains mixed categories: coding agents, agent frameworks, general assistants, memory systems, skills, browser tools, RAG infrastructure and adjacent products. It is **not** a top-100 coding-harness benchmark.

A separate [awesome-coding-agent catalogue](https://github.com/jqueryscript/awesome-coding-agent) was used to identify coding-specific comparators. Its README states a last-verified date of September 8, 2026; it is a useful additional discovery list, not a live ranking.

### What was actually inspected

- A complete recursive tree inventory of the audited OASIS commit: 1,418 tree entries, 1,206 tracked file blobs.
- OASIS's README, package metadata, brand guide, contribution/security/support documents, architecture, replacement roadmap, runtime-alternative study, benchmark methodology, CI workflows, update/release implementation and selected routing, shell-policy and provider-stream source/tests.
- A representative README/product-presentation sample: [OpenCode](https://github.com/anomalyco/opencode), [Codex CLI](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [OpenHands](https://github.com/OpenHands/OpenHands), [Cline](https://github.com/cline/cline), [Goose](https://github.com/aaif-goose/goose), [Pi](https://github.com/earendil-works/pi), [Superpowers](https://github.com/obra/superpowers), [Hermes Agent](https://github.com/NousResearch/hermes-agent), [Dify](https://github.com/langgenius/dify), [Mem0](https://github.com/mem0ai/mem0) and [OpenDesign](https://github.com/nexu-io/open-design).

The README's recorded real-model demonstration was added in commit [`20f44b8`](https://github.com/FAHTHIZ/oasis/commit/20f44b897f5f9e1ad574df483d94d4a92a52c77b). The demo metadata reports 6m 19s, seven tool calls and 50.9k tokens; those are details of that single recording, not a repeatable efficiency or performance claim. The full 100-entry index is preserved below so the reference set is auditable. **The 100 repositories were not each line-by-line audited.** The deep README sample is representative, not exhaustive. Index star/fork values are copied as published by that third-party source and were not independently refreshed against GitHub; they are included only to preserve its snapshot, not as verified metrics or quality scores.

## OASIS quality scorecard

Ratings describe evidence present in the repository at the audit commit. “Strong” means a credible foundation exists; it does not imply every implementation is complete or externally validated.

| Dimension | Rating | Evidence and remaining gap |
|---|---|---|
| Brand identity | **Strong** | Dedicated portal mark, logo, hero artwork, icon variants and `BRAND.md`. The design language is coherent and restrained. |
| First-screen product clarity | **Strong** | Clear statement of the product as a model-agnostic coding-agent runtime, plus a practical interface map. |
| Real product proof | **Strong (CLI) / Partial (cross-interface)** | The README now embeds a real, unscripted `gpt-oss-20b` CLI run as a GIF with MP4 and raw `.cast` recording. It shows file reading, a bug fix, a new test, approval and a verification send-back. This is qualitative evidence from one recorded run, not a standardized task benchmark. Browser, connected-workspace and desktop captures remain outstanding. |
| Installation accuracy | **Partial** | CLI and connected-session paths are documented. The docs said Node 22+, while `package.json` requires Node `>=22.15`; the desktop app has since been retired. |
| Release/distribution trust | **Gap** | The `v1.1.0` Git tag exists, but the GitHub Releases API returned no published release and `/releases/latest` returned 404. The release workflow is guarded, but users must not be told an installer is available until release assets are actually published. |
| Documentation navigation | **Partial** | Architecture and configuration guides exist, but the docs index omitted the architecture-alternatives and agent-runtime-alternatives documents. |
| Architecture transparency | **Strong / Partial** | Detailed runtime maps and replacement studies exist. The 437 KB agent module was recently reduced to about 425 KB by extracting provider-stream parsing, but lifecycle and dispatch remain highly concentrated. |
| Security disclosure | **Strong** | `SECURITY.md`, private reporting, explicit sandbox caveats, provider-data disclosure and trust-boundary documentation are present. |
| CI and regression discipline | **Strong** | Quality workflow covers Node 22/24/26, Linux/Windows/macOS security regressions, clean-environment tests, benchmark checks and the browser e2e workflow. |
| Evaluation evidence | **Partial** | Model-free harness and token-efficiency benchmarks exist. No controlled, published, same-model task-completion comparison against other coding agents was established by this audit. |
| Contributor onboarding | **Strong / Partial** | `CONTRIBUTING.md`, Code of Conduct, Support and issue templates exist; community pathways and governance can be made more discoverable. |
| Release communication | **Partial** | Changelog contains useful technical detail, but version headings were linked to release pages that do not exist. |

## What leading repositories do particularly well

The representative sample shows several repeatable practices worth adopting:

| Pattern | Strong examples | OASIS action |
|---|---|---|
| Lead with a real product image or walkthrough | OpenHands, OpenDesign, OpenCode, Hermes | The README now shows an actual CLI run, with an MP4 and raw terminal recording. Add separate web-app captures; keep hero brand art separate. |
| Separate install routes by product surface | Cline, Codex, Pi, OpenCode | Keep CLI, web app and editor paths clearly distinct, with exact prerequisites and truthful availability. |
| Show the product's boundary, not just its feature count | OpenHands, Goose, Gemini CLI | Explain where the runtime executes, what each interface can access, and which integrations are optional. OASIS already does much of this well. |
| Make docs and support one click away | OpenCode, Superpowers, Goose, Cline | Keep one authoritative docs index and add all maintained architecture/comparison pages to it. |
| Treat release status as product functionality | Codex, Pi, OpenCode | Ensure version, tag, release object, checksums, package assets and updater metadata agree before linking users to downloads. |
| Explain a distinct workflow in concrete terms | Superpowers, Hermes | Show one complete task lifecycle: prompt → plan → approval → tool work → verification → result. |
| Publish measured results with their limitations | Mem0, benchmark-oriented projects | Keep model-free harness, token, live task success, latency, cost and safety as separate metrics. Publish exact commit, model and task set. |

### What not to copy

- Do not add social, star, fork, trend or download badges unless the value is maintained and meaningful.
- Do not put unsupported claims such as “best”, “frontier-level on every model” or “100x better” into the README.
- Do not put a giant product feature catalogue on the first screen.
- Do not adopt a large framework simply because it appears in several popular repositories.
- Do not mistake a popular general-purpose AI app, skill collection or RAG tool for a direct coding-harness competitor.

## Prioritised improvement plan

### P0 — trust and first-run correctness

1. **Release state:** remove “latest release” and download claims until a GitHub Release and its assets actually exist. The `v1.1.0` tag and package version alone are not a downloadable release.
2. **Prerequisites:** use the exact package engine requirement, Node.js 22.15 or newer, consistently across README and contribution guides.
3. **Documentation map:** index architecture alternatives, agent-runtime alternatives and this benchmark.
4. **Release prompt:** change stale workflow copy that refers to publishing `v1.0.0` to refer to the current package version; do not weaken approval gates.

### P1 — prove the product

1. Capture web-app screenshots from a real-model run using representative, non-sensitive project content; the real CLI demonstration is now present.
2. Expand the README demo into a short product tour with meaningful captions, linking the raw terminal cast for inspection.
3. Add a clean first-run walkthrough: choose provider/model, connect a workspace, inspect permissions, run a task, review a diff, run checks and inspect verification.
4. Make the README's first screen answer: what it is, who it is for, what runs locally, how to try it and where to get help.

### P1 — keep the engineering story aligned with code

1. Keep the roadmap and architecture map current with provider-stream extraction and routing changes.
2. Continue the `src/agent.mjs` decomposition behind OASIS-owned contracts; characterize provider retries, cancellation, protocol metadata, permission decisions and recovery first.
3. Separate static validation from test execution, test pass rate, platform coverage and security evidence in CI summaries.
4. Track release status and docs consistency with automated link/version checks where practical.

### P2 — competitive proof

1. Pin a versioned task set with independent verifiers.
2. Run identical models, prompts, provider settings, tool availability and machine environments across OASIS and peer harnesses.
3. Report verified completion rate, regressions, intervention count, wall time, input/output tokens, cost, tool errors and safety-policy outcomes separately.
4. Repeat nondeterministic tasks and publish raw JSON/CSV, exact commits, configuration and environment details.
5. Add at least one weak/local model and one stronger API model; do not infer that a better harness removes model capability limits.

## Focused coding-agent reference set

This is a practical comparison set drawn from the separate coding-agent catalogue. It intentionally includes different product categories and licensing models; it is not a normalized ranking and should not be compared by raw stars.

| Project | Repository | What to inspect |
|---|---|---|
| 1 | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | CLI · Web · MIT |
| 2 | [OpenCode](https://github.com/anomalyco/opencode) | CLI · MIT |
| 3 | [Claude Code](https://github.com/anthropics/claude-code) | CLI · Closed Source |
| 4 | [Codex CLI](https://github.com/openai/codex) | CLI · Apache-2 |
| 5 | [Gemini CLI](https://github.com/google-gemini/gemini-cli) | CLI · Apache-2 |
| 6 | [Pi](https://github.com/earendil-works/pi) | CLI · MIT |
| 7 | [OpenHands](https://github.com/OpenHands/OpenHands) | CLI · Web · Autonomous · MIT |
| 8 | [Open Interpreter](https://github.com/openinterpreter/openinterpreter) | CLI · Apache-2 |
| 9 | [Cline](https://github.com/cline/cline) | IDE · CLI · Apache-2 |
| 10 | [Warp](https://github.com/warpdotdev/warp) | CLI · Desktop · AGPL-3 |
| 11 | [Goose](https://github.com/aaif-goose/goose) | CLI · Desktop · Apache-2 |
| 12 | [Aider](https://github.com/Aider-AI/aider) | CLI · Apache-2 |
| 13 | [Codewhale](https://github.com/Hmbown/Codewhale) | CLI · MIT |
| 14 | [Continue](https://github.com/continuedev/continue) | IDE · CLI · Apache-2 |
| 15 | [DeepSeek Reasonix](https://github.com/esengine/DeepSeek-Reasonix) | CLI · MIT |
| 16 | [GPT Pilot](https://github.com/Pythagora-io/gpt-pilot) | CLI · Source Available |
| 17 | [Cursor](https://github.com/cursor/cursor) | IDE · Desktop · Closed Source |
| 18 | [OH-MY-PI](https://github.com/can1357/oh-my-pi) | CLI · MIT |
| 19 | [Deep Agents Code](https://github.com/langchain-ai/deepagents) | CLI · MIT |
| 20 | [Crush](https://github.com/charmbracelet/crush) | CLI · Source Available |
| 21 | [Qwen Code](https://github.com/QwenLM/qwen-code) | CLI · Apache-2 |
| 22 | [Kilo Code](https://github.com/Kilo-Org/kilocode) | IDE · CLI · MIT |
| 23 | [Grok Build](https://github.com/xai-org/grok-build) | CLI · Apache-2 |
| 24 | [Dyad](https://github.com/dyad-sh/dyad) | Desktop · Source Available |

## Full 100-project AI-agent discovery index

Source: [sifted-network/sifted-awesome-ai-agents — AI Agents Top 100](https://github.com/sifted-network/sifted-awesome-ai-agents/blob/main/top100/AI%20Agents.md). Table data is a third-party snapshot retrieved on 2026-11-07. Stars, forks, language and activity date are source-reported only.

| Rank | Repository | Stars (source) | Language | Activity date (source) |
|---:|---|---:|---|---|
| 1 | [rea](https://github.com/morluto/rea) | 435,079 | TypeScript | 2026-11-06 |
| 2 | [superpowers](https://github.com/obra/superpowers) | 313,121 | Shell | 2026-11-03 |
| 3 | [hermes-agent](https://github.com/NousResearch/hermes-agent) | 260,940 | Python | 2026-11-06 |
| 4 | [firecrawl](https://github.com/firecrawl/firecrawl) | 199,016 | TypeScript | 2026-11-06 |
| 5 | [AutoGPT](https://github.com/Significant-Gravitas/AutoGPT) | 187,914 | Python | 2026-11-06 |
| 6 | [ponytail](https://github.com/DietrichGebert/ponytail) | 185,345 | JavaScript | 2026-10-29 |
| 7 | [agency-agents](https://github.com/msitarzewski/agency-agents) | 166,783 | Shell | 2026-11-06 |
| 8 | [dify](https://github.com/langgenius/dify) | 160,505 | Python | 2026-11-06 |
| 9 | [langflow](https://github.com/langflow-ai/langflow) | 156,370 | Python | 2026-11-06 |
| 10 | [langchain](https://github.com/langchain-ai/langchain) | 149,100 | Python | 2026-11-06 |
| 11 | [system-prompts-and-models-of-ai-tools](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools) | 144,508 | - | 2026-10-12 |
| 12 | [awesome-llm-apps](https://github.com/Shubhamsaboo/awesome-llm-apps) | 143,986 | Python | 2026-11-06 |
| 13 | [pi](https://github.com/earendil-works/pi) | 120,348 | TypeScript | 2026-11-06 |
| 14 | [browser-use](https://github.com/browser-use/browser-use) | 120,153 | Python | 2026-11-06 |
| 15 | [caveman](https://github.com/JuliusBrussee/caveman) | 117,818 | Go | 2026-11-06 |
| 16 | [claude-mem](https://github.com/thedotmack/claude-mem) | 113,643 | TypeScript | 2026-11-06 |
| 17 | [agent-skills](https://github.com/addyosmani/agent-skills) | 113,549 | JavaScript | 2026-11-01 |
| 18 | [taste-skill](https://github.com/Leonxlnx/taste-skill) | 110,805 | JavaScript | 2026-11-05 |
| 19 | [Agent-Reach](https://github.com/Panniantong/Agent-Reach) | 109,335 | Python | 2026-11-05 |
| 20 | [gemini-cli](https://github.com/google-gemini/gemini-cli) | 108,748 | TypeScript | 2026-11-06 |
| 21 | [open-design](https://github.com/nexu-io/open-design) | 106,165 | TypeScript | 2026-11-06 |
| 22 | [impeccable](https://github.com/pbakaus/impeccable) | 104,106 | Rust | 2026-11-05 |
| 23 | [autoresearch](https://github.com/karpathy/autoresearch) | 99,325 | Python | 2026-03-26 |
| 24 | [ragflow](https://github.com/infiniflow/ragflow) | 93,644 | Go | 2026-11-06 |
| 25 | [crawl4ai](https://github.com/unclecode/crawl4ai) | 86,963 | Python | 2026-11-04 |
| 26 | [lobehub](https://github.com/lobehub/lobehub) | 84,101 | TypeScript | 2026-11-06 |
| 27 | [ruflo](https://github.com/ruvnet/ruflo) | 81,009 | TypeScript | 2026-11-06 |
| 28 | [career-ops](https://github.com/career-ops-hq/career-ops) | 80,506 | JavaScript | 2026-11-06 |
| 29 | [Prompt-Engineering-Guide](https://github.com/dair-ai/Prompt-Engineering-Guide) | 79,854 | MDX | 2026-03-11 |
| 30 | [hyperframes](https://github.com/heygen-com/hyperframes) | 79,668 | TypeScript | 2026-11-06 |
| 31 | [ai-agents-for-beginners](https://github.com/microsoft/ai-agents-for-beginners) | 79,018 | Jupyter Notebook | 2026-11-02 |
| 32 | [headroom](https://github.com/headroomlabs-ai/headroom) | 78,956 | Python | 2026-11-06 |
| 33 | [OpenMontage](https://github.com/calesthio/OpenMontage) | 77,277 | Python | 2026-11-03 |
| 34 | [ai-engineering-from-scratch](https://github.com/rohitg00/ai-engineering-from-scratch) | 77,026 | Python | 2026-11-05 |
| 35 | [OpenBB](https://github.com/openbq-org/OpenBB) | 75,124 | Python | 2026-11-02 |
| 36 | [Front-End-Checklist](https://github.com/thedaviddias/Front-End-Checklist) | 74,659 | MDX | 2026-10-31 |
| 37 | [strix](https://github.com/usestrix/strix) | 73,990 | Python | 2026-11-05 |
| 38 | [MetaGPT](https://github.com/FoundationAgents/MetaGPT) | 71,188 | Python | 2026-01-21 |
| 39 | [claude-code-best-practice](https://github.com/shanraisshan/claude-code-best-practice) | 68,617 | HTML | 2026-11-06 |
| 40 | [mem0](https://github.com/mem0ai/mem0) | 68,487 | Python | 2026-11-04 |
| 41 | [last30days-skill](https://github.com/mvanhorn/last30days-skill) | 66,757 | Python | 2026-11-05 |
| 42 | [humanizer](https://github.com/blader/humanizer) | 65,330 | Python | 2026-10-28 |
| 43 | [context7](https://github.com/upstash/context7) | 64,254 | TypeScript | 2026-11-05 |
| 44 | [autogen](https://github.com/microsoft/autogen) | 61,721 | Python | 2026-10-28 |
| 45 | [crewAI](https://github.com/crewAIInc/crewAI) | 60,550 | Python | 2026-11-06 |
| 46 | [marketingskills](https://github.com/coreyhaines31/marketingskills) | 58,761 | JavaScript | 2026-11-04 |
| 47 | [ai-agent-book](https://github.com/bojieli/ai-agent-book) | 57,284 | Python | 2026-10-08 |
| 48 | [goose](https://github.com/aaif-goose/goose) | 56,273 | Rust | 2026-11-06 |
| 49 | [scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) | 56,237 | Python | 2026-11-02 |
| 50 | [Flowise](https://github.com/FlowiseAI/Flowise) | 55,557 | TypeScript | 2026-08-13 |
| 51 | [multica](https://github.com/multica-ai/multica) | 55,074 | Go | 2026-11-06 |
| 52 | [cherry-studio](https://github.com/CherryHQ/cherry-studio) | 53,298 | TypeScript | 2026-11-06 |
| 53 | [llama_index](https://github.com/run-llama/llama_index) | 52,825 | Python | 2026-11-05 |
| 54 | [CL4R1T4S](https://github.com/elder-plinius/CL4R1T4S) | 51,784 | - | 2026-09-22 |
| 55 | [react-bits](https://github.com/DavidHDev/react-bits) | 51,339 | JavaScript | 2026-10-31 |
| 56 | [LocalAI](https://github.com/mudler/LocalAI) | 50,222 | Go | 2026-11-05 |
| 57 | [qlib](https://github.com/microsoft/qlib) | 50,039 | Python | 2026-11-04 |
| 58 | [agentic-awesome-skills](https://github.com/sickn33/agentic-awesome-skills) | 49,230 | Python | 2026-11-05 |
| 59 | [herdr](https://github.com/herdrdev/herdr) | 48,344 | Rust | 2026-11-03 |
| 60 | [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) | 48,186 | C | 2026-11-04 |
| 61 | [CowAgent](https://github.com/zhayujie/CowAgent) | 47,808 | Python | 2026-11-06 |
| 62 | [siyuan](https://github.com/siyuan-note/siyuan) | 47,095 | TypeScript | 2026-11-06 |
| 63 | [LibreChat](https://github.com/LibreChat-AI/LibreChat) | 46,788 | TypeScript | 2026-11-05 |
| 64 | [AstrBot](https://github.com/AstrBotDevs/AstrBot) | 46,176 | Python | 2026-11-05 |
| 65 | [agent-browser](https://github.com/vercel-labs/agent-browser) | 46,024 | Rust | 2026-11-06 |
| 66 | [langgraph](https://github.com/langchain-ai/langgraph) | 44,537 | Python | 2026-11-06 |
| 67 | [iFixAi](https://github.com/ifixai-ai/iFixAi) | 43,698 | Python | 2026-11-02 |
| 68 | [agno](https://github.com/agno-agi/agno) | 43,076 | Python | 2026-11-06 |
| 69 | [OpenViking](https://github.com/volcengine/OpenViking) | 41,653 | Python | 2026-11-06 |
| 70 | [ToolJet](https://github.com/ToolJet/ToolJet) | 41,201 | HTML | 2026-11-06 |
| 71 | [ai-engineering-hub](https://github.com/patchy631/ai-engineering-hub) | 41,172 | Jupyter Notebook | 2026-11-01 |
| 72 | [awesome-copilot](https://github.com/github/awesome-copilot) | 40,852 | JavaScript | 2026-11-06 |
| 73 | [tidb](https://github.com/pingcap/tidb) | 40,712 | Go | 2026-11-06 |
| 74 | [posthog](https://github.com/PostHog/posthog) | 40,665 | Python | 2026-11-06 |
| 75 | [PageIndex](https://github.com/VectifyAI/PageIndex) | 40,059 | Python | 2026-11-06 |
| 76 | [mindshub](https://github.com/mindsdb/mindshub) | 39,841 | Makefile | 2026-10-23 |
| 77 | [UI-TARS-desktop](https://github.com/bytedance/UI-TARS-desktop) | 39,555 | TypeScript | 2026-10-09 |
| 78 | [500-AI-Agents-Projects](https://github.com/ashishpatel26/500-AI-Agents-Projects) | 39,325 | Python | 2026-11-05 |
| 79 | [ai-website-cloner-template](https://github.com/JCodesMore/ai-website-cloner-template) | 38,694 | TypeScript | 2026-10-19 |
| 80 | [CopilotKit](https://github.com/CopilotKit/CopilotKit) | 38,534 | TypeScript | 2026-11-06 |
| 81 | [dokploy](https://github.com/Dokploy/dokploy) | 38,270 | TypeScript | 2026-11-06 |
| 82 | [khoj](https://github.com/khoj-ai/khoj) | 38,013 | Python | 2026-08-02 |
| 83 | [claude-code-router](https://github.com/musistudio/claude-code-router) | 38,013 | TypeScript | 2026-10-10 |
| 84 | [WeKnora](https://github.com/Tencent/WeKnora) | 36,615 | Go | 2026-11-03 |
| 85 | [continue](https://github.com/continuedev/continue) | 36,414 | TypeScript | 2026-11-05 |
| 86 | [AgentGPT](https://github.com/reworkd/AgentGPT) | 36,266 | TypeScript | 2025-04-29 |
| 87 | [Claude-Code-Game-Studios](https://github.com/Donchitos/Claude-Code-Game-Studios) | 35,797 | Shell | 2026-10-19 |
| 88 | [Anthropic-Cybersecurity-Skills](https://github.com/mukul975/Anthropic-Cybersecurity-Skills) | 35,665 | Python | 2026-08-31 |
| 89 | [AionUi](https://github.com/iOfficeAI/AionUi) | 34,062 | TypeScript | 2026-11-05 |
| 90 | [pentagi](https://github.com/vxcontrol/pentagi) | 33,461 | Go | 2026-10-22 |
| 91 | [cognee](https://github.com/topoteretes/cognee) | 33,100 | Python | 2026-11-06 |
| 92 | [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) | 33,081 | C# | 2026-10-30 |
| 93 | [CodexPlusPlus](https://github.com/BigPizzaV3/CodexPlusPlus) | 32,930 | Rust | 2026-11-05 |
| 94 | [graphiti](https://github.com/getzep/graphiti) | 32,574 | Python | 2026-11-06 |
| 95 | [signoz](https://github.com/SigNoz/signoz) | 32,535 | TypeScript | 2026-11-06 |
| 96 | [conductor](https://github.com/conductor-oss/conductor) | 32,433 | Java | 2026-11-05 |
| 97 | [Jobs_Applier_AI_Agent](https://github.com/feder-cr/Jobs_Applier_AI_Agent) | 32,379 | Python | 2026-11-06 |
| 98 | [cli](https://github.com/googleworkspace/cli) | 32,134 | Rust | 2026-11-03 |
| 99 | [serena](https://github.com/oraios/serena) | 31,138 | Python | 2026-10-28 |
| 100 | [deepagents](https://github.com/langchain-ai/deepagents) | 31,020 | Python | 2026-11-05 |

## Audit maintenance rule

Re-run this scorecard after major UI, packaging, release, documentation or CI changes. Update the audited commit and reference snapshot date. Do not let a better-looking README get ahead of what the current branch actually ships.


## Subsequent product-surface decision

After this historical audit, the public Pages-based marketing website was retired. Its source directory, deployment workflow and site-specific build/QA scripts were removed. This does **not** retire the browser product: the root browser application, app/, src/web.mjs and its browser-app integrity tests remain in the repository. The browser workspace continues to connect to a local OASIS runtime; it is not a hosted website.

The new [user guide](USER-GUIDE.md), [interfaces guide](INTERFACES.md) and [release guide](RELEASES.md) are the maintained entry points for terminal, web app, remote access and download workflows.
