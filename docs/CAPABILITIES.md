# Capabilities and status

This page is the single place that says how mature each part of OASIS is. The
README and the guides link here instead of repeating status claims. Every row
names something that exists in the source on `main`; nothing here is a
performance claim.

| Label | Meaning |
| --- | --- |
| **Stable** | In the latest release ([v1.8.0](https://github.com/FAHTHIZ/oasis/releases/latest)), covered by automated tests and exercised in live runs on Linux. |
| **Released, lightly tested** | In the latest release and covered by unit or integration tests, but with few real-world hours. Expect rough edges. |
| **Unreleased** | Merged on `main` and tested, but not in a tagged release yet. Install from source to use it. See [Unreleased in the changelog](../CHANGELOG.md#unreleased). |
| **Experimental** | Works, but the interface or behaviour may change, or it depends on platform pieces OASIS cannot test in CI. |
| **Pending** | The code path exists; it switches on when something outside the repository is provided (a certificate, a token, a paid run). |
| **Not claimed** | Deliberately not promised. |

## Platforms

| Platform | Status |
| --- | --- |
| Linux | Verified by automated tests and live runs |
| Windows and macOS | Tested in CI (security and runtime regression tests, installer scripts), not by hand |
| Desktop installers for all three | Built in CI; not yet code-signed |

## Core runtime

| Capability | Status | Where to read more |
| --- | --- | --- |
| Agent turn loop, tool calls, streaming, compaction, checkpoints and `/rewind` | Stable | [Architecture](ARCHITECTURE.md) |
| Permission modes (`plan` … `dont-ask`), shell-command risk analysis, protected paths, secret scanning | Stable | [Security model](SECURITY.md) |
| Verification gate: a reply that claims success without a reviewed diff or a passing check is sent back | Stable | [Architecture](ARCHITECTURE.md) |
| `mutation_probe`: revert check and planted bugs on the changed lines show whether the tests catch a regression in the change | Unreleased | [User guide](USER-GUIDE.md#do-the-tests-catch-a-bug-in-the-change) |
| `bisect_regression`: `git bisect` in an isolated worktree finds the first commit that broke a check, with endpoint checks and skip support | Unreleased | [User guide](USER-GUIDE.md#which-commit-broke-it) |
| `flaky_check`: reruns a check (optionally several copies at once) to tell a reproducible failure from a flaky one, with error signatures and likely causes | Unreleased | [User guide](USER-GUIDE.md#is-the-failure-real) |
| `minimize_repro`: delta debugging shrinks a failing input to the lines (or characters) that still reproduce the same failure | Unreleased | [User guide](USER-GUIDE.md#shrink-a-failing-input) |
| `localize_fault`: spectrum-based fault localization (Ochiai over per-test line coverage) ranks the lines most likely to hold a bug | Unreleased | [User guide](USER-GUIDE.md#where-is-the-bug) |
| Evidence checks for research (cite only fetched pages) and analysis (numbers must come from code that ran) | Stable | [Agent network](AGENT-NETWORK.md#evidence-and-contracts) |
| `/debate`: advocates argue assigned positions with quoted, fetched evidence over typed moves (challenge, concede, counter, withdraw); disputed points are fact-checked independently; a judge rules on the ledger with consensus, dissent and cruxes | Unreleased | [Workflows](WORKFLOWS.md#debate-a-contested-question) |
| Workflow agents held to the report contracts: a rejected report is retried with the reasons, then fails; citations are checked against what the whole run fetched | Unreleased | [Agent network](AGENT-NETWORK.md#evidence-and-contracts) |
| Contested findings: the knowledge board keeps disagreeing findings (different figures, negation, opposites) as a dispute instead of merging them, and reports open disputes to the parent | Unreleased | [Subagents](SUBAGENTS.md#disagreements) |
| Source independence: syndicated copies and same-site pages count as one source when corroborating (`source_independence`, knowledge board, `deep-research`) | Unreleased | [Agent network](AGENT-NETWORK.md#source-independence) |
| Quote-verified citations: direct quotes must appear on the fetched page they cite; `verify_quote` checks them first | Unreleased | [Agent network](AGENT-NETWORK.md#quote-checks) |
| Sessions, resume, fork, export (`/export`, HTML and Markdown) | Stable | [Terminal guide](TERMINAL.md) |
| Memory across sessions, `session_search`, `/learning` skill proposals | Released, lightly tested | [Extending OASIS](EXTENDING.md) |
| `/goal` (keep working until a condition holds), routines and schedules (`oasis schedule`) | Released, lightly tested | [User guide](USER-GUIDE.md) |
| General-purpose system prompt with rules for research, data and writing deliverables | Unreleased | [Changelog](../CHANGELOG.md#unreleased) |

## Agent network

| Capability | Status | Where to read more |
| --- | --- | --- |
| Built-in subagents (`explore`, `plan`, `general-purpose`, `code-review`, `security-review`), custom agent files | Stable | [Subagents](SUBAGENTS.md) |
| Parallel and background agents, agent teams with a shared task board, worktree isolation | Released, lightly tested | [Subagents](SUBAGENTS.md) |
| One scheduler, per-agent budgets, crash-safe ledger, cancellation and leases | Released, lightly tested | [Agent network](AGENT-NETWORK.md) |
| Scripted workflows (`workflow` tool, built-in `/audit` and `/deep-research`) | Released, lightly tested | [Subagents](SUBAGENTS.md) |
| Research and analysis domain packs (`plugins/oasis-research`, `plugins/oasis-analysis`) | Released, lightly tested | [Extending OASIS](EXTENDING.md#domain-packs) |
| Best-of-N attempts in parallel worktrees (`oasis attempts`) | Released, lightly tested | [User guide](USER-GUIDE.md#best-of-n-attempts) |
| `mixture_of_agents`: ask several models the same question and merge the answers | Unreleased | [Changelog](../CHANGELOG.md#unreleased) |
| Subagents with their own virtual desktop (`environment: "desktop"`) | Unreleased, experimental | [Computer use](COMPUTER_USE.md) |
| Control room: every agent on this computer, its screen, history and spend | Unreleased | [Control room](CONTROL_ROOM.md) |
| Agent experience: evidence-decided outcomes per run, recall of earlier runs, `oasis agents experience`, optional experience-based model routing | Unreleased | [Subagents](SUBAGENTS.md#experience) |
| Calibrated confidence: findings on the knowledge board carry a stated confidence, are settled by corroboration, retraction or disputes, and are scored per model (Brier, reliability); readers see and search by the calibrated value, `oasis agents calibration` | Unreleased | [Subagents](SUBAGENTS.md#calibrated-confidence) |
| Memory belief revision: contradicting saves replace the old statement and keep it in a revision history, supersede conflicting memories, need evidence to overturn a verified memory, flag flip-flops; `memory_save from_finding` saves a checked knowledge board finding with its provenance | Unreleased | [Memory](MEMORY.md#belief-revision) |
| Shared knowledge board for the agents of a session (`knowledge_post`, `knowledge_search`), with posts checked against the poster's evidence | Unreleased | [Subagents](SUBAGENTS.md#shared-knowledge-board) |

## Interfaces

| Interface | Status | Where to read more |
| --- | --- | --- |
| Terminal (`oasis`), one-shot and scripted runs (`oasis -p`, `oasis exec`) | Stable | [Terminal guide](TERMINAL.md) |
| Self-hosted web app (`oasis web`), including remote access from another device | Stable | [Remote access](REMOTE-ACCESS.md) |
| Desktop app (Electron, same runtime as `oasis web`) | Released, lightly tested; installers not code-signed | [Desktop app](DESKTOP.md) |
| Editors over the Agent Client Protocol (`oasis acp`) and the VS Code-family extension | Released, lightly tested | [Interfaces](INTERFACES.md) |
| Codex App Server protocol (`oasis app-server`) and Cursor Cloud Agents API | Released, lightly tested | [Compatibility](COMPATIBILITY.md) |
| Node.js SDK (`src/sdk.mjs`), MCP server (`oasis mcp serve`) | Released, lightly tested | [Interfaces](INTERFACES.md) |
| GitHub Action (`action.yml`) and cloud runs on GitHub Actions (`oasis cloud run`) | Released, lightly tested | [User guide](USER-GUIDE.md#cloud-agents-on-github-actions) |
| Chat gateways: Telegram, Slack, Discord | Released, lightly tested | [Gateways](GATEWAYS.md) |
| Chat gateways: WhatsApp, Mattermost, Matrix, Signal, email | Unreleased | [Gateways](GATEWAYS.md) |
| A2A 1.0/0.3 server (`oasis a2a serve`) and `remote_agent` client | Unreleased | [A2A](A2A.md) |

## Execution environments

| Environment | Status | Where to read more |
| --- | --- | --- |
| Local workspace with approvals (no sandbox) | Stable | [Security model](SECURITY.md) |
| bubblewrap (Linux) and Docker sandboxes | Stable | [Execution backends](EXECUTION-BACKENDS.md) |
| macOS Seatbelt profile | Released; unit-tested only | [Execution backends](EXECUTION-BACKENDS.md) |
| Podman, SSH remote machines | Released, lightly tested | [Execution backends](EXECUTION-BACKENDS.md) |
| Daytona and Modal cloud sandboxes, Apptainer/Singularity, gVisor (`runsc`) runtime | Unreleased | [Execution backends](EXECUTION-BACKENDS.md) |
| Built-in Chrome browser tool over CDP (`--chrome`), with session recordings | Released, lightly tested | [User guide](USER-GUIDE.md) |
| Desktop computer use (`--computer-use`) on Linux, macOS and Windows | Unreleased, experimental | [Computer use](COMPUTER_USE.md) |

## Models and integrations

| Capability | Status | Where to read more |
| --- | --- | --- |
| OpenAI-compatible endpoints, Anthropic, Gemini, OpenRouter and local servers (Ollama, LM Studio, llama.cpp, vLLM, Jan) | Stable | [Configuration](CONFIGURATION.md#model-providers) |
| Bedrock, Vertex AI, Azure AI Foundry | Released, lightly tested | [Configuration](CONFIGURATION.md#model-providers) |
| Fallback models, task-aware routing, zero-budget mode and spend limits | Released, lightly tested | [Inference](INFERENCE.md) |
| MCP client (stdio, HTTP, SSE, OAuth, elicitation, MCP Tasks) and the MCP Registry | Stable | [Extending OASIS](EXTENDING.md) |
| 48 built-in app connectors with an in-chat Connect card | Released, lightly tested | [Extending OASIS](EXTENDING.md) |
| Claude Code plugins, skills, hooks and settings; Codex plugins and Gemini CLI extensions converted on install | Stable for Claude Code plugins; others released, lightly tested | [Compatibility](COMPATIBILITY.md) |
| `generate_image`, `text_to_speech` through OpenAI-compatible APIs | Released, lightly tested | [Configuration](CONFIGURATION.md) |
| Honcho user modeling, Home Assistant tools, `/personality` | Unreleased | [Configuration](CONFIGURATION.md) |
| Trajectory export for training (`--compress`, `--format hermes`) | Unreleased | [Compatibility](COMPATIBILITY.md#imports-and-data-formats) |

## Pending

| Item | What is missing |
| --- | --- |
| Signed and notarized desktop installers | The release workflow signs them once Developer ID and Windows certificates are added as repository secrets ([Releases](RELEASES.md#turning-on-npm-and-code-signing)). |
| `npm install -g oasis-oss` from the npm registry | Publishing runs when an `NPM_TOKEN` secret exists. Until then, install from a GitHub Release or from source. |
| Published Terminal-Bench or SWE-bench score | A Harbor adapter exists in `bench/harbor/`, but no full scored run has been made; those need a strong model and paid runs. |

## Not claimed

- Production readiness for untrusted code without the OS sandbox, a container
  or a throwaway machine. Approval prompts are not isolation.
- Results with paid frontier models: none of the published runs used one.
- That every model will solve every task. On a given task the model you connect
  usually matters more than the harness.
- A hosted service. OASIS runs on computers and servers you control; `oasis
  cloud` uses your own GitHub Actions runners and model key.

## Known limitations

| Limitation | Why | Workaround |
| --- | --- | --- |
| No tuning for one model family | OASIS works across many providers, so prompts and tool schemas cannot be tuned for a single vendor's models the way a vendor's own agent can. | `oasis connect` tests candidate models with a real tool call and keeps the first that works. |
| Few real-world hours | The automated suite is large (more than 3,700 tests), but the user base is small, so edge cases surface more slowly. | Report problems in [Issues](https://github.com/FAHTHIZ/oasis/issues). |
| Edits are applied without asking in `default` mode | A deliberate choice for speed; edits are checkpointed and can be rewound, and protected config paths still prompt. | Use `plan` mode, or `ask` rules for `edit_file`. |
| Plugin cost | Each enabled plugin adds tools and prompt text. | Large MCP servers move behind `tool_search`; skills are listed by name and loaded on demand. |
| Small local models | Small models follow long tool lists less reliably, and some local servers default to a 4,096-token window. | `oasis connect http://localhost:11434` creates a 32K-window `-oasis` copy of an Ollama model. |
| Core size | `src/agent.mjs` (about 4,200 lines) and `src/cli.mjs` (about 3,900 lines) are still large. | Splitting continues; provider retry, request shaping, budgets, turn guards, compaction and tool results are already separate modules. |

Development evidence (benchmarks, real-model runs and their limits) lives in
[docs/development](development/BENCHMARKS.md), not in this status page.
