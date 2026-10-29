# OASIS current implementation status

**Audit date:** October 29, 2026  
**Last fully verified implementation revision before the follow-up patches in this commit:** [`9ed2cc9f98d24691a3e902983538110b02284589`](https://github.com/FAHTHIZ/oasis/commit/9ed2cc9f98d24691a3e902983538110b02284589). [Quality Checks run 40860786973](https://github.com/FAHTHIZ/oasis/actions/runs/40860786973) passed 651 tests with zero failures, the Node.js 22/24/26 matrix, 33 evaluation fixtures, Linux PTY, authenticated browser E2E, and Ubuntu/macOS/Windows security regressions. [Publishing validation run 40860786970](https://github.com/FAHTHIZ/oasis/actions/runs/40860786970) and [desktop packaging/release run 40860787120](https://github.com/FAHTHIZ/oasis/actions/runs/40860787120) also passed on that same SHA.
**Verification boundary:** the verified `9ed2cc9` revision includes strict saved/runtime/turn budget validation, process-tree cleanup for the evaluator, Git tools, persistent background sessions, shell/background runner, diagnostics and language servers, plus bounded HTTP MCP `headersHelper` output and process-tree termination. The next patch serializes OAuth token-store updates, refuses to overwrite malformed token files and makes settings-file mutations atomic/private; validate those changes on the new SHA before marking them verified. Live status: [Quality](https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml), [publishing validation](https://github.com/FAHTHIZ/oasis/actions/workflows/pages.yml), [desktop builds](https://github.com/FAHTHIZ/oasis/actions/workflows/desktop-build.yml).  
**Package version:** `0.3.0` · **Runtime:** Node.js 22+ · **License:** MIT

This is the repository-grounded status page. It separates shipped implementation, automated evidence and known gaps. A feature name, passing unit test, or successful artifact build is not by itself proof of cross-platform readiness or competitive coding quality. See [Next milestone](NEXT_MILESTONE.md) for the prioritized Alpha-confidence checklist and the [whole-codebase gap register](WHOLE_CODEBASE_GAP_REGISTER.md) for code-backed closure criteria.

The core mechanics are documented in [Core mechanics audit](CORE_MECHANICS_AUDIT.md). The external comparison is optional engineering evidence—not a product definition or parity goal. See the [whole-codebase gap register](WHOLE_CODEBASE_GAP_REGISTER.md) for the implementation-backed remaining gaps and their closure criteria.

## Executive assessment

OASIS has grown into a feature-rich, local-first coding-agent project: CLI and headless runtime, multiple hosted/local model routes, tools for editing and verification, MCP, skills/hooks/plugins, session memory, subagents and task coordination, a browser workspace with a PTY/xterm path, a VS Code-family extension, a GitHub Action, and a desktop packaging pipeline.

The last fully verified implementation baseline before the follow-up fixes was `9ed2cc9`: 651 tests passed on Node.js 22/24/26, all 33 evaluation fixtures validated, and the PTY, browser E2E, cross-platform security, publishing and desktop packaging jobs passed on that same revision. The fixture suite remains a smoke/regression suite rather than a representative repository-level coding benchmark. `oasis eval --compare` compares saved reports across shared task IDs.

## Verified repository and CI snapshot

**Last fully verified code snapshot before the follow-up patches:** `9ed2cc9f98d24691a3e902983538110b02284589` (October 29, 2026; see [Quality Checks run 40860786973](https://github.com/FAHTHIZ/oasis/actions/runs/40860786973)). The run passed 651 tests, validated 33 fixtures, and passed Node 22/24/26, security regressions, native PTY and browser E2E.

| Evidence | Latest verified result |
| --- | --- |
| Runtime modules | 61 `.mjs` modules under `src/` after adding the process-tree termination helper |
| Test layout | Node.js test specifications plus shared helpers; latest verified main code run reports 651 passing tests |
| Latest verified Node test suite | **651 passed, 0 failed** on Node.js 22/24/26 in [Quality Checks run 40818083171](https://github.com/FAHTHIZ/oasis/actions/runs/40818083171) |
| Latest fully verified evaluation-fixture validation | **33/33 valid**; still a smoke suite, not a representative coding benchmark |
| Node runtime matrix | Node.js 22, 24 and 26 passed in run 40818083171 |
| Native PTY check | Passed on Linux / Node.js 22 in run 40818083171; this is not proof of Windows/macOS/Termux support |
| Browser E2E | Authenticated Linux Chromium chat smoke test passed in run 40818083171, including workspace write/read |
| Package integrity | Production-package checks passed in the latest Quality Checks run |
| Desktop packaging | [Build OASIS desktop installers run 40807290603](https://github.com/FAHTHIZ/oasis/actions/runs/40807290603) passed on Windows, macOS and Linux for comparator code revision `268862c`. Installers remain unsigned. |
| Homepage/repository validation | [Homepage/repository validation run 40807290592](https://github.com/FAHTHIZ/oasis/actions/runs/40807290592) passed on comparator code revision `268862c` |
| Release maturity | Package version `0.3.0`; CI can build desktop installers, but the current installers are unsigned and first-run behavior is not yet proven across all supported operating systems |

Quality Checks [run 40860786973](https://github.com/FAHTHIZ/oasis/actions/runs/40860786973), publishing validation [run 40860786970](https://github.com/FAHTHIZ/oasis/actions/runs/40860786970), and desktop packaging/release [run 40860787120](https://github.com/FAHTHIZ/oasis/actions/runs/40860787120) passed on the same implementation revision `9ed2cc9`. The OAuth token-store and user-settings persistence follow-up in this commit requires fresh same-SHA verification. Browser E2E runs in Linux Chromium and does not establish Android/Termux, real-device TLS, cross-browser, live-cloud-provider, or full Windows/macOS PTY lifecycle readiness.

## What the code currently provides

### 1. Coding-agent runtime and CLI

- Interactive terminal editor with multiline input, workspace history/search, tab completion, type-ahead, interruption, streamed Markdown, and edit diffs.
- Multi-step model/tool loops for OpenAI Responses, OpenAI-compatible Chat Completions, and Anthropic Messages.
- One-shot/headless text, JSON, and stream-JSON workflows, an SDK, budget/cost tracking, token/tool-call limits, saved sessions, and best-effort context compaction.
- Workspace-bound read/write/edit/delete tools, glob/search, shell and argv command tools, background-process controls, package-install planning, checkpoints, backups, rewind, and Git operations.
- Slash commands and workflows including `/plan`, `/goal`, `/batch`, `/simplify`, `/verify`, `/btw`, `/recap`, `/loop`, `/schedule`, `/commit`, and `/pr`.
- The CLI now exposes persistent PTY sessions to the agent; the browser workspace renders them with bundled xterm.js. Native PTY support still needs Windows/macOS validation and reliable process-tree cleanup, and this is not yet a polished standalone full-screen CLI TUI.

### 2. Models and providers

- Native OpenAI Responses, OpenAI-compatible Chat Completions, and native Anthropic Messages protocol.
- Supported provider paths include Anthropic on AWS Bedrock, Google Vertex and Microsoft Foundry (Azure), plus compatible gateways and local endpoints such as OpenRouter, Gemini's OpenAI-compatible endpoint, Ollama/LM Studio, and OmniRoute.
- Provider setup verifies an inert tool call before saving settings; configured models must support tool calling.
- Claude on Microsoft Foundry is supported natively (`foundry` protocol). A native Gemini adapter is not implemented in this baseline. A Gemini-compatible endpoint is not the same as a native Gemini adapter. Live authenticated testing of all cloud accounts is still needed.

### 3. Code understanding and verification

- File listing, ranged reads, exact-string patch edits, snapshots/checkpoints, Git status/diff/log/commit/branch/push tooling, and worktree creation.
- Language-server support for navigation, references, hover, symbols, call hierarchy and diagnostics, plus detected type-checker/linter diagnostics.
- PDF text extraction, notebook cell reading/editing, and image input for vision-capable providers.
- Web search and bounded public-document fetching.
- `oasis eval` uses reviewed reference tasks and verifiers. Its 21-task starter set is intentionally too small and utility-heavy to rank large-repository coding performance reliably.

### 4. Agents and task coordination

- Built-in/custom subagents with separate context, bounded parallel execution, background status, steering/resume/cancel tools, and optional worktree isolation.
- Separate specialist reviews for code, security, architecture, and test strategy are bounded and read-only.
- A shared **session-local** dependency-aware task board is available to the main agent and child agents through `task_create`, `task_list`, `task_get`, and `task_update`. It validates task IDs, prerequisite existence, cycles, and blocked status transitions. Its task data is included in saved sessions.
- The board supports exclusive lease-based `task_claim`/`task_renew`/`task_release`, dependency gates, and shared status. `dispatch_ready_tasks` starts a bounded wave of ready tasks as background agents in isolated worktrees, skips active claims and already-running assignments, and tags each agent with its task ID. By default, the coordinator launches one manual wave; with explicit `auto_dispatch: true`, OASIS refills freed slots and launches newly unblocked tasks as workers finish. It records each task's worker branch/commit and defers dependent work until prerequisite commits are integrated into the main checkout; it pauses with a review/integration message instead of running downstream tasks against stale code. Failed/cancelled/incomplete workers also pause chaining and release an incomplete worker's lease when safe. The live scheduler is session-scoped; saving an active auto-dispatch workflow now records a sanitized recovery checkpoint, and resuming the session marks the workflow interrupted rather than reviving nonexistent workers. It still is not a persistent scheduler and never merges worktrees automatically.
- Running agents can message peers directly; `team_create`, `team_status`, and `team_shutdown` provide named session-local teams, a member roster, membership-aware messaging, and controlled shutdown. This is model-directed wave dispatch, not an autonomous persistent scheduler: there is no cross-session synchronization, dedicated visual team manager, automatic conflict repair, or dynamic-workflow script runner.
- Worktree isolation can keep independent edits apart, but it is an explicit execution choice, not an automatic coordination guarantee.

### 5. Integrations, skills, and extensions

- MCP stdio and Streamable HTTP support, server configuration, OAuth flows where supported, resources, prompt exposure, deferred tool discovery, and an MCP server mode.
- Hooks, custom slash commands, output styles, layered memory, auto memory, a reviewed capability catalog, and portable Agent Skills.
- Inspect/import flows recognize compatible tooling, Codex, Gemini CLI and portable-skill layouts. Imported Markdown prompts and standard text resources can be supported, while native hooks, scripts, dependency lifecycle execution, full command semantics, and all ecosystem manifest features are not automatically activated. This is **not** drop-in compatibility with every third-party plugin.
- An optional OpenHands bridge can delegate to a separately configured, running Agent Server; OASIS does not install or provision that remote service for you.
- A GitHub Action supports `@oasis`-triggered issue/PR workflows.

### 6. Browser workspace and public site

- `oasis web` serves a local-hosted authenticated agent runtime with streamed responses, visible tool activity, approvals, saved sessions, and a workspace command runner.
- Non-loopback use expects TLS certificates unless the operator explicitly opts into insecure LAN HTTP. Device certificate/trust onboarding and real-device security tests remain incomplete.
- The browser dashboard's projects/tasks/notes use browser local storage. They do **not** sync with CLI workspace data or the agent shared-task board.
- Browser GitHub access reuses the host's GitHub CLI login (`gh auth login`); it is not embedded GitHub OAuth or a GitHub App integration.
- The static public site is served through GitHub Pages. It is not a desktop/mobile app or a remote cloud-agent service.

- The browser includes a Run history panel backed by the authenticated `GET /api/jobs` API, with bounded local summaries and retrieval after runtime restart. Records remain under the host's private OASIS configuration directory, with atomic writes, size limits, and common credential redaction; this is not hosted compute or cross-device sync.
- Browser chat offers an opt-in isolated Git-worktree mode. It requires a clean checkout, runs edits on a separate branch, applies a bounded heuristic secret scan before automatic commit, and exposes a capped diff preview through an authenticated API. The main checkout is not auto-merged; if a scan or finalization fails, the worktree is retained for review. This feature was verified in Quality Checks run 40817267789. Secret-pattern scanning is a safety layer, not a complete security guarantee.

## Code inventory

All 60 files listed here are in `src/` and participate in the shipped codebase. This categorization is for navigation, not a guarantee that every combination is end-to-end tested.

| Subsystem | Source modules |
| --- | --- |
| Agent loop, coordination, sessions, memory and recovery | `agent.mjs`, `agent-tasks.mjs`, `auto-memory.mjs`, `auto-mode.mjs`, `backups.mjs`, `checkpoints.mjs`, `context.mjs`, `memory.mjs`, `session-tools.mjs`, `sessions.mjs`, `cloud-task-store.mjs`, `shared-tasks.mjs`, `subagents.mjs` |
| CLI and interaction | `cli.mjs`, `clipboard-path.mjs`, `clipboard.mjs`, `commands.mjs`, `completion.mjs`, `headless.mjs`, `input-history.mjs`, `line-editor.mjs`, `markdown.mjs`, `output-styles.mjs`, `slash.mjs`, `status-line.mjs`, `terminal-ui.mjs`, `update.mjs` |
| Configuration, policy and safety | `config.mjs`, `doctor.mjs`, `hooks.mjs`, `permissions.mjs`, `sandbox.mjs`, `settings.mjs` |
| Workspace tools, Git and verification | `diagnostics.mjs`, `eval.mjs`, `git-tools.mjs`, `images.mjs`, `installer.mjs`, `json-schema.mjs`, `lsp.mjs`, `notebook.mjs`, `pdf.mjs`, `power-tools.mjs`, `pricing.mjs`, `tools.mjs`, `worktrees.mjs` |
| Providers, protocols and integrations | `cloud-providers.mjs`, `extensions.mjs`, `github-action.mjs`, `mcp-auth-commands.mjs`, `mcp-extras.mjs`, `mcp-oauth.mjs`, `mcp-project.mjs`, `mcp-serve.mjs`, `mcp.mjs`, `plugins.mjs`, `sdk.mjs`, `telemetry.mjs`, `web-search.mjs`, `web.mjs` |

Repository-level verification also covers `index.html`, `manifest.webmanifest`, `sw.js`, the public landing page and its metadata checks, `action.yml`, CI workflows, 15 bundled skill guides, the test suite and 22 evaluation fixtures.

## Highest-impact remaining gaps

Prioritized by the risk they pose to release confidence and everyday usefulness—not by how exciting or visible a new feature would be.

1. **Keep CI deterministic and expand regression depth.** The `FileChanged` test now waits for hook-message delivery; the latest full test matrix passes on Node 22/24/26. Continue repeated focused runs and add supported-OS process lifecycle coverage.
2. **Measure real coding outcomes.** `oasis eval --compare` now compares repeated-run reports over common task IDs, reporting task-balanced pass rate, median task time and mean cost. The 33-fixture starter suite is still too small and utility-heavy to measure repository-level software work; expand it to at least 50 representative tasks and run a reproducible cross-run benchmark with pinned snapshots/models where possible, acceptance tests, repeated trials, and reviewed diffs.
3. **Validate product journeys across platforms.** The Linux/Node 22 PTY smoke and Linux Chromium chat smoke are useful, but they do not prove native PTY cleanup on Windows/macOS or first-run/update/uninstall behavior for every desktop installer. Termux remains experimental for PTY.
4. **Finish multi-agent lifecycle visibility.** Teams, leases, activity events, bounded worktree dispatch, and tmux panes exist. The remaining gaps are a visual agent/run monitor, durable pause/resume across process restarts, cross-session messaging, and conflict-aware integration. Avoid claiming self-coordinating persistent teams.
5. **Only then expand remote surfaces.** Remote/mobile/hosted sessions need authenticated identity, trusted-device management, workspace isolation, execution policy, reconnect/recovery, and audit trails—not simply a network-accessible web server.
6. **Continue platform/safety work.** No Windows OS sandbox exists; the optional Linux/macOS sandbox is off by default. When enabled, it now masks detected common credential paths, but this is not full filesystem-read isolation and macOS runtime behavior still needs validation. The macOS Keychain writer no longer places the plaintext secret in subprocess argv; a real macOS check and Windows fallback-file ACL verification remain open. Temporary archive cleanup after crashes is not guaranteed. A native Gemini adapter and JetBrains plugin remain gaps. Installers are unsigned, and the latest security-hardening commit is still awaiting the full workflow matrix.

See [Next milestone](NEXT_MILESTONE.md) for the task-level checklist and acceptance criteria.

## Safety and release-readiness boundaries

- The optional OS sandbox is disabled by default and currently targets Linux and macOS. There is no Windows sandbox. Without the sandbox, approved project scripts execute with the host user's OS privileges.
- Permission prompts and path checks reduce risk but are not a substitute for OS isolation. A local model does not make code execution safe.
- Third-party plugin imports are safety-reviewed subsets; detection does not mean full runtime compatibility.
- History compaction is heuristic. Long sessions still need provider-by-provider and long-horizon evaluation for continuity.
- The browser command panel has a PTY-backed path with a bundled xterm.js renderer. The web runtime supports HTTPS with user-provided certificate/key files for non-loopback access; broader terminal lifecycle and real-device TLS validation remain open.
- The last completed Quality Checks and publishing validation passed on `e0591d6`, but its desktop build was cancelled. Subsequent security-hardening commits are pending full same-SHA verification. Passing CI does not establish a full security audit, real-device support, cross-platform usability or equivalence with compatible tooling's code quality.

## File-by-file security pass (in progress)

This pass prioritizes security and reliability boundaries before feature breadth. It is a living review log—not a claim that every tracked file has been fully audited.

- **Network egress:** `src/network-safety.mjs`, `src/public-fetch.mjs`, `src/mcp-oauth.mjs`, `src/zip.mjs`, `src/browser-tool.mjs`; shared IPv4/IPv6 policy, private/special IPv6 ranges, IPv4-mapped addresses and NAT64 translation now have regression coverage.
- **Command execution and OS sandbox:** `src/permissions.mjs`, `src/sandbox.mjs`, `src/settings.mjs`; chained shell permission matching, option-prefixed package-manager verbs, sandbox profile control characters, credential masking and trusted opt-out now have targeted tests.
- **Secret storage and cloud identity:** `src/secure-store.mjs`, `src/cloud-providers.mjs`; macOS Keychain writes avoid plaintext argv, and Google/Azure token caches are scoped to profile/project/tenant context. Real macOS behavior and Windows ACL semantics remain unverified.
- **Verification and docs:** `test/network-safety.test.mjs`, `test/command-risk.test.mjs`, `test/sandbox.test.mjs`, `test/power.test.mjs`, `test/secure-store.test.mjs`, `test/cloud-providers.test.mjs`, and `test/claude-settings-compat.test.mjs` cover the changes above. Related limitations are recorded in `SECURITY.md` and `SECURITY_RELIABILITY_AUDIT.md`.

Still requiring deeper passes: full `src/agent.mjs` and context/compaction lifecycle, workspace-file symlink/TOCTOU behavior, session and memory persistence, MCP server and OAuth execution boundaries, browser origin/authentication behavior, and process/PTY lifecycle on each supported platform. The 33-fixture eval suite remains a starter set; competitive coding quality needs a reproducible 50-task representative repository benchmark.

## Source references

- [Code baseline before this documentation refresh](https://github.com/FAHTHIZ/oasis/commit/268862c783ed27e697c1dd540690d1548ea8cd77)
- [Evaluation comparison implementation](https://github.com/FAHTHIZ/oasis/commit/75cb5e7947ac58e5cfe3273ad384de1298d10848)
- [Evaluation comparison CLI wiring](https://github.com/FAHTHIZ/oasis/commit/268862c783ed27e697c1dd540690d1548ea8cd77)
- [Latest Quality Checks — passed](https://github.com/FAHTHIZ/oasis/actions/runs/40804769809)
- [Latest homepage/repository validation — passed](https://github.com/FAHTHIZ/oasis/actions/runs/40804769832)
- [Latest desktop build matrix — passed](https://github.com/FAHTHIZ/oasis/actions/runs/40804769799)

- [Security and reliability audit](SECURITY_RELIABILITY_AUDIT.md)
- [Alpha-confidence milestone](NEXT_MILESTONE.md)

## PTY milestone update (October 29, 2026)

The agent runtime now has a real PTY session manager wired into the approved `run_command` path. Set `interactive=true` to start a persistent interactive session; `terminal_read`, `terminal_input`, `terminal_resize`, `terminal_interrupt`, `terminal_stop`, and `terminal_list` control it. The manager bounds captured output and input, limits active sessions, tracks exit status, supports incremental reads and stops sessions when the parent OASIS session closes. The native `node-pty` binding is optional and lazy-loaded; ordinary commands keep working if it is unavailable.

This is **partial terminal and desktop-install groundwork, not completion of the whole gap**. The browser now has an xterm.js renderer connected to authenticated PTY routes. Native PTY integration is tested on Linux/Node 22. Process-tree termination was added for command/hook timeout and cancellation, but Windows/macOS behavior and cross-platform process cleanup remain open until CI/runtime verification confirms them. Desktop install packaging is scaffolded for Windows, macOS and Linux, but platform build artifacts must pass and signing credentials are not configured, so a verified signed release has not shipped.