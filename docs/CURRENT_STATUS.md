## Quality verification queue — 2026-10-31

The Quality concurrency group has been rotated from `oasis-quality-v9` to `oasis-quality-v10` after the prior run continued against an older source commit. The rotation starts independent verification for the current main snapshot; it does not remove tests, relax gates, or mark any prior run as passed.

---

## Cost-aware model routing — 2026-10-31

- Added opt-in `/routing` configuration for user-selected easy and strong model IDs, loaded only from trusted user settings.
- Ordinary terminal and browser prompts use a conservative read-only classifier. The evaluation harness can separately supply pinned fixture-difficulty hints for controlled routed trials.
- Per-turn summaries and evaluation reports expose selected models and pricing-based cost estimates. Comparisons use observed token counts and are not measured counterfactuals or guaranteed savings.

**Verification boundary:** the feature and its focused regression tests are present on `main`. Treat it as implemented, not as evidence of real-world cost savings or capability parity; current release readiness is governed by the same-commit Quality, Pages, installer, and desktop workflows.

---

## Phase 2 workspace shell and navigation — October 30, 2026

The main browser shell now follows the redesign brief's chat-first navigation model.

- Replaced the old primary sidebar navigation with OASIS branding, New chat, a project-picker entry, a saved-chat list grouped by Today / Yesterday / Earlier, and Settings at the bottom.
- Connected saved chats to the existing authenticated /api/sessions endpoint. The sidebar and preserved chat-session selector use the same runtime session list; opening a sidebar item resumes its saved conversation.
- Added a 52px project-context header with the active workspace name, a local-workspace pill, local-only status, context placeholder, cost placeholder, and Terminal / Changes / Tasks controls.
- Created a Settings hub for the pre-existing Overview, Projects, Tasks, Notes, Run monitor, Model provider, GitHub, Integrations, Extensions, appearance, search and backup screens. The original pages and their IDs remain in the app.
- Split the right utility rail into three accessible tabs: Terminal, Changes (selected run activity and isolated diff review), and Tasks (recent coding-run history). The same saved-run and diff code is reused; no second history store was introduced.
- Added top-bar open/close behavior, keyboard navigation for utility tabs, monitor-to-Changes routing, and a dismissible phone sidebar drawer that opens from the menu button and closes on outside tap or Escape. The previous seven-item mobile bottom navigation is removed.
- Expanded browser E2E to cover Settings navigation, the project-picker route, New chat, saved-chat loading, top-bar utility controls, all three panels, phone drawer behavior, and desktop / 390px screenshots plus axe checks.

Known data limits: the existing /api/status response supplies the active workspace name and provider configuration, but does not supply a Git branch or cost figure. The header therefore labels the context as a local workspace and leaves cost as an em dash instead of fabricating branch or billing information. The project-picker chip currently opens the existing Projects screen; selecting a Git repository continues through the established GitHub panel flow. The current local workspace selector is not yet a repository switcher.

Verification boundary: browser E2E and axe checks for this exact revision are pending. Screenshot artifacts are not treated as verified until the same-revision workflow publishes them. The automated 390px checks do not substitute for a physical Android/Termux run.


---

## Phase 3 conversation-first Agent workspace — October 30, 2026

The browser Agent view has been reshaped around the conversation while preserving its existing runtime and permission flows.

- Replaced the oversized page intro with a compact workspace heading and a clear local-workspace indicator.
- Made the runtime token card more compact and grouped its label, local-session note, connect/disconnect actions and explanatory copy.
- Reworked the conversation header to keep model/runtime identity, permission mode, saved chats, context meter and New chat controls in a single responsive header.
- Reworked the composer into a full-width prompt plus a separate context/actions row on desktop; phone layout stacks prompt, isolated-worktree option and Send/Stop controls.
- Preserved the terminal split, divider resizing, terminal visibility, narrow-screen Chat/Terminal tabs, approval/question cards, saved-session behavior, provider setup and GitHub workspace controls. No server routes or permission semantics were changed for this layout pass.
- Moved the existing saved-run list and isolated-worktree diff review into separate **Tasks** and **Changes** views beside Terminal. The three views share one utility column and are keyboard/tab accessible; selecting a run or opening a review from the Agent monitor opens Changes. The original history and diff handlers are reused.
- Added browser E2E screenshot coverage for empty state, connected chat, connection failure, approval, terminal, Changes, Tasks, provider settings and first-run at desktop and/or 390px widths. Axe color-contrast scans cover the connection error, provider settings, Changes and Tasks states too.
- Added a static layout integrity check for the desktop split, desktop/mobile composer structure, utility rail, and 390px breakpoint.

**Verification boundary:** the updated browser/quality run for this exact revision is pending. Screenshot files are generated by CI when browser E2E passes; no local screenshot was generated in this session. The 390px width check is automated and does not replace a real Android device test. Android/Termux remains experimental for native PTY and is not being claimed as supported by this browser layout work.


---

## Phase 1 visual system — October 30, 2026

The visual foundation is implemented directly on `main` and is now aligned to the app redesign brief.

- Kept `assets/oasis-interface.css` as a local, separately maintained stylesheet and kept it in the offline app-shell cache.
- Set the workspace canvas, sidebar, panels, borders, text and muted text to the exact values in the redesign brief: `#0B100C`, `#0D130E`, `#101811`, `#1C271F`, `#2B3B30`, `#E8EFE9`, and `#9BAA9F`.
- Reserved action lime `#9BFF55` for Send, New chat and approval actions. Generic primary buttons and selected navigation states remain neutral.
- Added Inter and JetBrains Mono font stacks, 14px conversation text, quieter 12.5px activity text, and 44px phone touch targets for send and approval controls.
- Added token-level WCAG contrast calculations to `scripts/check-site.mjs` for primary, muted, risk and lime-action text. The required combinations are checked against the 4.5:1 threshold.
- Added pinned, CI-only `@axe-core/playwright@4.14.0` scans to the authenticated browser E2E for desktop Agent, approval, terminal/chat at 390px, and first-run at desktop/390px. Color-contrast violations fail the browser test; the package is not an OASIS runtime dependency.
- Corrected the CI test's stale quality concurrency-group expectation and made the Agent verification gate honor an explicitly non-blocking LSP result. Source edits still require a recognized project check to pass.
- Preserved the OASIS portal mark artwork and did not change provider, approval-policy, terminal-command or runtime permission behavior.

**Verification boundary:** static token checks and contrast calculations are in place. Fresh CI for this revision must pass the full quality matrix, clean-environment suite, browser E2E/axe scans, and package checks. Playwright screenshots are produced by CI for workspace and first-run desktop/390px states; the full requested six-state screenshot set and manual phone/desktop review remain for the later layout steps.


---

## Phase 0 finish-plan follow-up — October 30, 2026

## Current-main Gate A verification — October 30, 2026

- Current `main`: [`b85b850`](https://github.com/FAHTHIZ/oasis/commit/b85b850c68b1f722bbee5904fe1b44b59e998683).
- Quality Checks: [run 41055081277](https://github.com/FAHTHIZ/oasis/actions/runs/41055081277), triggered for this exact SHA; publishing validation: [run 41055081196](https://github.com/FAHTHIZ/oasis/actions/runs/41055081196). Both were queued/in progress when checked; neither is recorded as passed.
- Previous Quality run [41052480430](https://github.com/FAHTHIZ/oasis/actions/runs/41052480430) passed Linux PTY and Ubuntu/macOS/Windows security jobs but the clean-environment suite failed 2 of 796 tests. The failures were (1) an Action integration fixture that did not mirror the production unattended LSP-disable environment and (2) a QuickJS Date sandbox constructor/prototype compatibility regression.
- Follow-up main commits [`6f358c3`](https://github.com/FAHTHIZ/oasis/commit/6f358c39cec96f41ba09b4499f79ce85bdf292b3), [`21276b8`](https://github.com/FAHTHIZ/oasis/commit/21276b8c4523e7e2590f40ebfd312c8b5b733848), and [`90ed7ca`](https://github.com/FAHTHIZ/oasis/commit/90ed7cab39ea8485a08b4bb0ab6a37588ba90376) address the two failures. The latest-main CI run must confirm the fixes before Gate A closes.


The first Phase 0 implementation slice has been applied directly to `main`.

- The public product lifecycle is Beta. The Beta confidence and release-quality gates track verification maturity; they do not relabel the product as Alpha.
- The Agent view no longer contains the stray literal escaped newline.
- The site-integrity test checks the Agent markup and verifies that the sidebar references a populated `assets/oasis-mark.svg`. The SVG already existed and was not replaced.
- Credential-redaction output has a regression test for stable placeholders. No production redaction change was needed because the inspected implementation already produced the expected output.
- Unattended GitHub Action runs set `OASIS_DISABLE_LSP=1`, receive an explicit instruction not to launch LSP processes, and use project test/lint/build/type-check commands as the verification path. Regression tests cover the LSP policy and Action option wiring.
- Gate A triage: Quality run [41052480430](https://github.com/FAHTHIZ/oasis/actions/runs/41052480430) on an intermediate main revision exposed two clean-environment regressions. The Action fixture used an unsupported `canUseTool` option instead of mirroring the production LSP-disable policy; it now sets `OASIS_DISABLE_LSP=1`. The QuickJS Date sandbox nulled the constructor prototype of a class that still relied on `super()`, breaking `new Date(...)`; `SafeDate` is now a guarded function constructor using `Reflect.construct`, so its constructor chain can be hidden without breaking Date instances. Both fixes require fresh current-main CI evidence before Gate A can close.

**Verification boundary:** direct-main commits trigger GitHub Actions validation. The full Node 22/24/26 integrity matrix, clean-environment suite, Linux PTY integration, cross-platform security checks, and repository publishing validation must pass on the latest main commit before Gate A is closed. Earlier partial results from superseded branches are not treated as proof for current main. Gate A remains open.

The Quality run for the preceding release candidate remained active after its test commands stopped reporting progress, holding the `oasis-quality-v6` concurrency group and preventing the current-main run from starting. The workflow concurrency group has been rotated to `oasis-quality-v9` so the current `main` snapshot can receive an independent verification run. The previous run remains visible for diagnosis; this change does not cancel it, change any test requirement, or mark a gate passed.
---


## Latest verified main snapshot

**Audit date:** October 29, 2026  
**Verified implementation revision before this documentation-only refresh:** [0002f84a534cd1498b83b5e78fede53922aca7e5](https://github.com/FAHTHIZ/oasis/commit/0002f84a534cd1498b83b5e78fede53922aca7e5). [Quality Checks run 40870856114](https://github.com/FAHTHIZ/oasis/actions/runs/40870856114) passed **685 Node tests, 0 failures** on the Node 22/24/26 matrix and passed the clean-environment suite, Linux native PTY integration, and Ubuntu/macOS/Windows security regression jobs. The run validates all **33 evaluation fixtures** and the authenticated browser E2E, including first-run choices, starter prompt fill, responsive chat/terminal controls, dangerous-action denial and cancellation before a command side effect.
**Publishing validation:** [run 40870856141](https://github.com/FAHTHIZ/oasis/actions/runs/40870856141) passed on the same implementation SHA. Desktop installer workflow [run 40870856180](https://github.com/FAHTHIZ/oasis/actions/runs/40870856180) was still in progress when this note was written; installers are unsigned and a successful build would not prove clean-machine first-run, update or uninstall readiness. The docs-only refresh itself has not yet received its own CI run.

## Current-main follow-up — quality and publishing verified

The current implementation revision [`fef120a`](https://github.com/FAHTHIZ/oasis/commit/fef120a52af030249aae1ba1b1df2e0cf4054a81) has fresh passing CI evidence:

- [Quality Checks run 40882893190](https://github.com/FAHTHIZ/oasis/actions/runs/40882893190) passed on Node.js 22, 24 and 26; clean-environment tests; the Ubuntu/macOS/Windows security regression jobs; Linux native PTY integration; and the authenticated browser end-to-end smoke test. The full quality gate and CLI package checks passed on all three Node versions.
- [Publishing validation run 40882893526](https://github.com/FAHTHIZ/oasis/actions/runs/40882893526) passed on the same revision.

The snapshot evaluator now supports reusable, safely named repository snapshots. The browser workspace also includes an authenticated **Agent run monitor** with redacted worker/team events, run/worktree metadata, approval counts, available token totals and a lifecycle timeline. On restart, saved workers and teams are marked interrupted, and outstanding approvals are counted as interrupted rather than displayed as live or actionable. Regression tests cover the observer boundary, run attribution, redaction, metadata, restart-state handling and authentication. A guarded **Open saved chat** action now reopens a completed/interrupted workspace-mode run's saved parent conversation in Agent; isolated worktree runs do not expose a potentially stale session. The browser E2E verifies the original user request and assistant response are restored after reopening.

**Remaining lifecycle boundary:** this preserves the run record and saved parent conversation, not the live Node.js worker processes or pending approval state. The monitor still cannot pause/resume running agents across process restarts or reconcile every stale task lease. For completed isolated tasks, it now shows a merge-safety preview and exposes an explicit confirmation step; Git conflicts, overlapping paths, dirty checkouts, stale main/agent commits, already-integrated commits, and interrupted/uncommitted work are blocked. The source worktree and branch remain in place after a merge. This browser merge path is awaiting fresh CI evidence. CI passing is evidence for the configured regression suite—not proof of production readiness, a complete security audit, or parity with Claude Code.

This status section records the last verified code/workflow revision above. Any subsequent code change must be checked against its own fresh main-branch workflow results.
 
## Executive assessment

OASIS is a feature-rich, local-first coding-agent project rather than a documentation-only prototype. The repository includes a CLI/headless runtime, model/provider adapters, permissioned tools, snapshots and rewind, saved sessions, subagents and task coordination, MCP/skills/hooks/plugins, diagnostics and LSP, a browser workspace, VS Code-family integration, a GitHub Action, and desktop packaging. New user-facing work in this pass adds a three-path first-run setup, desktop-only OS-encrypted API-key storage with rollback on config-save failure, fixed-localhost Ollama discovery, plain-language approval prompts and credential redaction, a responsive chat/terminal split, empty-chat starter cards, terminal status metrics, grouped help, startup tips, and a searchable Ctrl+K palette.

The Ctrl+K palette searches built-in/custom commands, skills, settings and recent saved sessions. Selecting an entry places the command into the prompt for review; it does not auto-execute. The browser E2E regression suite now exercises denial of a risky delete and cancellation before a command executes.

The 33-item evaluation suite is a regression/smoke suite, not a representative repository-level coding benchmark. CI coverage is not a penetration test or proof of universal platform support. The design-only phone connection threat note is now present at [PHONE_CONNECT_SECURITY.md](PHONE_CONNECT_SECURITY.md), but phone pairing remains unimplemented and must not be started until the user has read the threat note.

## Verified repository and CI snapshot

| Evidence | Latest verified result |
| --- | --- |
| Implementation SHA | 0002f84a534cd1498b83b5e78fede53922aca7e5 |
| Quality Checks | [Run 40870856114](https://github.com/FAHTHIZ/oasis/actions/runs/40870856114): 685 passed, 0 failed; Node 22/24/26; clean environment; 33/33 eval fixtures; Linux PTY; browser E2E; Ubuntu/macOS/Windows security regressions |
| Browser E2E | Passed on the above SHA: authenticated chat, workspace file write/read, first-run options, starter prompt behavior, responsive workspace controls, risky delete denial, and pending-approval cancellation |
| Publishing validation | [Run 40870856141](https://github.com/FAHTHIZ/oasis/actions/runs/40870856141) passed on the same SHA |
| Desktop packaging | [Run 40870856180](https://github.com/FAHTHIZ/oasis/actions/runs/40870856180) was still in progress when reviewed; installers remain unsigned |
| Release maturity | Package version 0.3.0; actual clean-machine installation, signing, first-run/update/uninstall and accessibility checks remain incomplete |
| Device coverage | Linux PTY is tested in CI; real Windows/macOS user journeys, real-device TLS, Android/Termux and full cross-platform PTY lifecycle remain separate verification gaps |

This status page distinguishes implementation, automated evidence and known gaps. A feature name, passing unit test or successful artifact build is not by itself proof of cross-platform readiness or competitive coding quality. See [Next milestone](NEXT_MILESTONE.md) and the [whole-codebase gap register](WHOLE_CODEBASE_GAP_REGISTER.md).

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
- [Beta-confidence milestone](NEXT_MILESTONE.md)

## PTY milestone update (October 29, 2026)

The agent runtime now has a real PTY session manager wired into the approved `run_command` path. Set `interactive=true` to start a persistent interactive session; `terminal_read`, `terminal_input`, `terminal_resize`, `terminal_interrupt`, `terminal_stop`, and `terminal_list` control it. The manager bounds captured output and input, limits active sessions, tracks exit status, supports incremental reads and stops sessions when the parent OASIS session closes. The native `node-pty` binding is optional and lazy-loaded; ordinary commands keep working if it is unavailable.

This is **partial terminal and desktop-install groundwork, not completion of the whole gap**. The browser now has an xterm.js renderer connected to authenticated PTY routes. Native PTY integration is tested on Linux/Node 22. Process-tree termination was added for command/hook timeout and cancellation, but Windows/macOS behavior and cross-platform process cleanup remain open until CI/runtime verification confirms them. Desktop install packaging is scaffolded for Windows, macOS and Linux, but platform build artifacts must pass and signing credentials are not configured, so a verified signed release has not shipped.