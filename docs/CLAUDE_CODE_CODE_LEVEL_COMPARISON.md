# OASIS Implementation Audit and External Capability Benchmark

**Updated:** October 31, 2026  
**OASIS source snapshot reviewed:** [508a0a68d4760f07c22a4037eeb26a6d83c7216f](https://github.com/FAHTHIZ/oasis/commit/508a0a68d4760f07c22a4037eeb26a6d83c7216f); subsequent commits fixed test-only assertion patterns and refreshed this comparison.  
**Claude Code stable release:** [2.1.314](https://github.com/anthropics/claude-code/releases/tag/v2.1.314), published October 30, 2026; 2.1.315 was listed on the `next` tag and is not treated as stable here.  
**Method:** inspect OASIS source, registered tools, tests, fixtures, product-readiness records and CI configuration; compare them with Claude Code's official release notes and documentation. Claude Code's private runtime remains unavailable for a line-by-line source audit. This is a source-and-documentation comparison, not a measured head-to-head benchmark or a claim of parity.

## Executive verdict: OASIS on its own merits

OASIS is an independent product with its own roadmap and engineering identity. This report uses Claude Code only as an external reference for the requested source-backed comparison; it is a diagnostic instrument, not OASIS's definition of success. OASIS is a substantial, implemented coding-agent product. Its source contains a multi-step model/tool loop, repository operations, command execution, permission evaluation, optional OS sandboxing, context compaction, persistent sessions, memory, MCP, hooks, skills, subagents, worktrees, workflows, diagnostics and language-server support. These are present in code, not just a roadmap.

That establishes **broad architectural and capability overlap** with Claude Code. It does **not** establish equal success rate, patch quality, speed, reliability or security. Those are behavioral outcomes that need controlled evaluation.

The most important gap supported by current evidence is **benchmark strength**: the checked-in evaluation manifest has 33 tasks (16 labelled small and 17 medium, none large). Most exercise bounded helper logic, input handling and security/configuration cases. They are useful regression tests, but not enough to support a broad “as capable as Claude Code” claim. The existing benchmark audit also records that no authenticated live head-to-head result has been published. See [Benchmark audit](BENCHMARK_AUDIT.md) and the actual [task manifest](../evals/tasks/metadata.json).

The second major caveat is execution isolation. OASIS's OS sandbox is optional, disabled by default, and targets Linux/macOS; native Windows commands use approval controls without OASIS OS sandbox enforcement. Claude Code's shell sandbox is also off by default, supports macOS/Linux/WSL2, and does not sandbox native Windows commands. In both products the sandbox is a shell-process boundary, not full OS isolation of every file tool, MCP server or hook. OASIS's built-in file tools separately constrain access to the workspace and explicitly added directories. Neither product should be called fully secure merely because sandboxing exists. See OASIS [sandbox implementation](../src/sandbox.mjs) and Claude Code's [sandbox documentation](https://code.claude.com/docs/en/sandboxing).

## Evidence boundary: what can and cannot be compared

### OASIS source is inspectable

The repository's default branch contained 585 Git tree entries at the audited revision, including large runtime modules and a broad test suite. The primary sources reviewed include:

- [Agent loop — src/agent.mjs](../src/agent.mjs#L3014-L3395), including [tool authorization/dispatch](../src/agent.mjs#L2803-L2940) and [post-edit verification tracking](../src/agent.mjs#L3209-L3359).
- [Tool definitions and execution — src/tools.mjs](../src/tools.mjs), plus [power tools](../src/power-tools.mjs), [Git tools](../src/git-tools.mjs), [diagnostics](../src/diagnostics.mjs), [LSP](../src/lsp.mjs), [session tools](../src/session-tools.mjs) and [agent-team tasks](../src/agent-tasks.mjs).
- [Permission rules and command-risk analysis](../src/permissions.mjs), [OS sandbox selection/wrapping](../src/sandbox.mjs), [memory retrieval](../src/auto-memory.mjs), [memory file loading](../src/memory.mjs), [session persistence](../src/sessions.mjs), [subagent definitions](../src/subagents.mjs), [workflow execution](../src/workflows.mjs), [MCP clients](../src/mcp.mjs), [hooks](../src/hooks.mjs), and [Claude-format plugin interoperability](../src/claude-plugins.mjs).
- [Runtime regression tests](../test/runtime.test.mjs), [permission tests](../test/permissions.test.mjs), and [evaluation task metadata](../evals/tasks/metadata.json).

This audit records what those files implement and what the checked-in tests exercise. It does not infer behavior merely from a feature name or a README claim.

### Claude Code's official release is not a public runtime source tree

The official [Claude Code GitHub repository](https://github.com/anthropics/claude-code) publishes project documentation, scripts, examples, plugin material and supporting files. The stable [2.1.314 npm package listing](https://unpkg.com/@anthropic-ai/claude-code@2.1.314/) contains its platform-specific CLI package, installer/wrapper files, package metadata and generated [SDK tool-input/output declarations](https://unpkg.com/@anthropic-ai/claude-code@2.1.314/sdk-tools.d.ts). The 2.1.314 release notes document a working-directory write guard for file writes/edits/notebook edits and idle compaction for Desktop/VS Code conversations above 200K tokens. The published declarations and release notes establish shipped contracts and documented behavior; they are **not** the private CLI runtime implementation.

For that reason, this report does not present a line-by-line comparison with Claude Code internals, invent hidden implementation details, or treat documentation as proof of enforcement. Claude's public schema proves that a tool contract is shipped; it does not, by itself, prove how that tool is implemented internally, the conditions under which it is allowed, or its failure rate. Where no corresponding public runtime implementation was available, the report labels the internal comparison **not verifiable from official public artifacts**.

## OASIS implementation findings

### 1. Core agent loop and completion discipline

**Source evidence:** [src/agent.mjs](../src/agent.mjs#L3014-L3395).

The runtime repeatedly requests model output, dispatches tool calls, appends tool results to the conversation and continues until a stop condition or bounded limit. It checks cancellation, caps steps and tool calls, uses a token budget, compacts older history, and repairs interrupted tool-call history. Consecutive read-only work may run concurrently while tool results are restored to the order the model requested.

OASIS also has an explicit post-edit verification state machine. It tracks changed paths, whether the full diff or changed files were reviewed, and the exit status of recognized verification commands. A later edit clears prior review/check state. If the model attempts to finish too early, the runtime sends a targeted continuation requiring a full diff review (or rereading each changed file in a non-Git directory) and a relevant test/check/lint/build/type-check command. The gate can still end as incomplete; a write response alone is not accepted as verification.

**Test evidence:** [test/runtime.test.mjs](../test/runtime.test.mjs#L905-L1457) includes regression cases for long-session compaction, mid-turn compaction preserving the active request and latest tool-call/result pairing, a post-edit verification gate, and cases that reject incomplete reads or irrelevant commands as verification.

**Comparison result:** The official Claude Code tool schema exposes a broad tool loop surface, including Agent, Bash, file read/edit/write, plan-mode, task, workflow and worktree contracts. The official documentation also describes an iterative gather-context / act / verify pattern. Those sources support a comparison at the behavior-category level, but not a claim that the internal loops or enforcement logic are identical. Actual relative performance remains a benchmark question.

### 2. Repository access and edits

**Source evidence:** [src/tools.mjs](../src/tools.mjs), [src/power-tools.mjs](../src/power-tools.mjs), and [test/runtime.test.mjs](../test/runtime.test.mjs).

OASIS has distinct tools for listing, reading, globbing and searching workspace files; exact-string edits, multi-edit, notebook edits and whole-file writes; Git status/diff/log/branch/commit/push and worktree operations; plus bounded text/file output. The primary tools module caps an individual text file at 256 KiB and ordinary tool output at 24 KiB. Workspace traversal, sensitive paths and escaping symlinks are guarded; writes can create recoverable snapshots; deletion requires explicit interactive approval.

The checked-in tests exercise path traversal, sensitive-file reads/edits, escaping symlinks, explicit deletion approval, exact edit failure behavior, snapshots and Git path protection.

**Comparison result:** Claude Code's official shipped schema includes FileRead, FileEdit, FileWrite, Glob and Grep contracts. The same broad editing/search surface is publicly evident. Contract overlap is not proof of identical path policies, edit reliability or patch quality; compare those with adversarial repository tasks and review the resulting diffs.

### 3. Command execution, approvals and sandboxing

**Source evidence:** [src/tools.mjs](../src/tools.mjs), [src/power-tools.mjs](../src/power-tools.mjs), [src/permissions.mjs](../src/permissions.mjs), and [src/sandbox.mjs](../src/sandbox.mjs).

OASIS separates argv-style command execution from shell/PowerShell execution. The tool description requires approval unless the user explicitly enables the yes/auto-approve path, blocks destructive executables or shell interpreters unless explicitly allowed, supports background processes and optional persistent PTYs, and exposes process-output/termination tools. Permission rules have an explicit precedence of deny over ask over allow over the mode default. The command analyzer is deliberately conservative around shell operators and command substitution, so uncertain syntax fails closed rather than being guessed safe.

OS sandbox selection and wrapping are implemented separately from tool-level approvals. They are useful defense-in-depth, but they are not always active: the OS sandbox is optional, disabled by default, and the current project documentation identifies Linux/macOS as its supported targets. Windows therefore remains a material isolation gap compared with a product whose configured execution environment provides the required isolation.

**Test evidence:** [test/permissions.test.mjs](../test/permissions.test.mjs) covers command-prefix allow rules, mixed command chains, quoted operators and fail-closed treatment of command substitution. The CI workflow also runs filesystem, network, secret-store and sandbox regressions on Ubuntu, Windows and macOS.

**Comparison result:** Claude Code's public schema includes Bash and file-operation contracts, and its public documentation describes permission and sandbox controls. The schema does not reveal equivalent enforcement implementation details. Therefore a safe claim is “similar control problem and visible tool contract,” not “equal sandboxing.” Establish parity only with a published policy matrix and matched denial, escape, injection, process cleanup and cancellation tests.

### 4. Context, memory and sessions

**Source evidence:** [src/agent.mjs](../src/agent.mjs), [src/auto-memory.mjs](../src/auto-memory.mjs), [src/memory.mjs](../src/memory.mjs), and [src/sessions.mjs](../src/sessions.mjs).

OASIS stores workspace-scoped sessions and has explicit recall, history compaction and mid-turn compaction paths. Memory retrieval ranks candidate saved notes and can redact secrets before persistence. The runtime compacts old completed history while preserving the active request and the newest tool-call/result relationships, rather than simply deleting arbitrary messages.

**Test evidence:** Runtime tests assert that older history is summarized before a later request and that mid-turn compaction preserves the current task and the latest call/result pair.

**Comparison result:** Claude Code 2.1.314 documents idle compaction for Desktop and VS Code conversations above 200K tokens that remain idle. OASIS compacts older history at configured thresholds before a later request and has a separate mid-turn compaction path; it does not currently provide the same idle-triggered Desktop/VS Code behavior. Neither product's public contracts prove its internal memory-ranking quality. A meaningful quality comparison requires long-session tasks with predefined facts, context pressure, interruption/restart and measured recall correctness.

### 5. Delegation, task coordination and workflows

**Source evidence:** [src/subagents.mjs](../src/subagents.mjs), [src/agent-tasks.mjs](../src/agent-tasks.mjs), [src/worktrees.mjs](../src/worktrees.mjs), [src/workflows.mjs](../src/workflows.mjs), and [src/session-tools.mjs](../src/session-tools.mjs).

OASIS contains agent definitions and tool restrictions, bounded parallel runners, background-agent lifecycle/status and messaging, named teams, a session-local shared task board, and dynamic JavaScript workflows with phases/pipelines/parallel work and schema-checked results. Editing subagents can use separate Git worktrees. The implementation describes dispatch as model-directed rather than claiming a fully autonomous scheduler, and branches are not merged automatically.

**Comparison result:** Claude Code's public tool schema contains Agent, TaskCreate/TaskGet/TaskUpdate/TaskList/TaskStop, Workflow, EnterWorktree and ExitWorktree contracts. This is strong surface-level overlap. The quality questions are task decomposition, safe isolation, integrating conflicting changes, recovering failed workers and useful final synthesis; names and declarations do not answer them. Those questions need multi-file tasks and repeated runs.

### 6. MCP, hooks, skills, plugins, search and IDE surfaces

**Source evidence:** [src/mcp.mjs](../src/mcp.mjs), [src/hooks.mjs](../src/hooks.mjs), [src/claude-plugins.mjs](../src/claude-plugins.mjs), [src/agent.mjs](../src/agent.mjs), [src/web-search.mjs](../src/web-search.mjs), [src/ide.mjs](../src/ide.mjs), and [ide/vscode](../ide/vscode).

These are implemented integrations, not just planned items: configurable MCP servers and tool refresh, hook execution, plugin/marketplace discovery and activation, skills, configurable web search, a VS Code-compatible editor integration and a browser workspace. The product documents specific compatibility limits and does not promise that every third-party or enterprise plugin behaves identically.

Claude Code's official repository exposes public plugin and example material, and the released tool schema includes MCP, skill-proposal, WebSearch, WebFetch and several other contracts. It also lists some product-specific contracts (for example Projects, ClaudeDesign, Artifacts, remote triggers and notifications) that were not found as same-named direct built-in tools in the OASIS tool-definition files reviewed here. That is a narrow registry observation, not proof that no analogous workflow or extension can achieve a similar result.

## Capability comparison

| Area | OASIS source evidence | Claude Code public-release evidence | Finding |
| --- | --- | --- | --- |
| Iterative agent/tool loop | Runtime loop, bounded limits, cancellation and recovery in source | Official docs plus Agent/Bash and file-tool contracts | Same product category; internal equivalence cannot be verified |
| File reads, search and edits | Concrete workspace tools, path checks, snapshots and tests | FileRead/FileEdit/FileWrite/Glob/Grep schemas | Broad overlap; needs matched patch-quality tests |
| Shell and terminal work | argv execution, shell/PowerShell, PTY/background process handling, permission analysis | Bash schema and public terminal workflow descriptions | Broad overlap; sandbox equivalence not demonstrated |
| Plan and task state | Plan mode, todo list, task board and session tools | EnterPlanMode/ExitPlanMode, TodoWrite, Task* contracts | Broad overlap |
| Subagents and parallelism | Bounded agent pool, teams, background agents and worktree support | Agent and worktree/task contracts | Broad overlap; outcome quality unmeasured |
| Context and memory | Source-level session persistence, retrieval, threshold-based pre-request compaction and mid-turn compaction tests | Public memory/file-read contracts; v2.1.314 adds idle compaction in Desktop/VS Code | Broad overlap; OASIS lacks the same idle-triggered UI compaction behavior; no memory-quality parity claim |
| Permissions and OS isolation | Explicit rules, fail-closed command parsing, workspace path validation and optional Linux/macOS shell sandbox | Claude's shell sandbox is optional and supports macOS/Linux/WSL2, not native Windows; v2.1.314 adds a write-outside-working-directories guard for file tools | Both have a default-off shell-sandbox boundary; test platform behavior directly. OASIS file tools already confine writes to workspace/explicit dirs, but neither tool-level path policy equals OS-level shell isolation |
| MCP/hooks/plugins/skills | Source-backed clients, hooks and plugin integration | Public contracts, GitHub plugin material and SDK tool types | Strong interoperability/capability overlap; compatibility remains feature-specific |
| Diagnostics/language services | Diagnostics and LSP modules | The inspected official tool schema is not a complete inventory of every internal runtime feature | Compare by task results, not tool-name count |
| Browser, IDE and workflow surfaces | Browser workspace, VS Code integration, dynamic workflows and monitors | Official repository/docs expose terminal, IDE, plugins and public tool contracts | Different product surfaces; compare specific user journeys |
| Product-specific tools and hosted features | OASIS centers on local workspaces, sessions, artifacts, workflows, browser history and integrations | Claude Code documents hosted cloud sessions, mobile Dispatch, remote/SSH environments and additional IDE surfaces | Potential product-surface gaps; verify user need and implement deliberately rather than adding empty stubs |
| Proven coding performance | 33 deterministic regression/eval tasks in manifest | No comparable result inferred from tool schemas | Not established for either side by this audit |

## Current Claude Code capability comparison — October 31, 2026

The official docs now describe more than a single terminal coding loop. They document custom and built-in subagents, background sessions and an Agent view, agent teams, a broad hook lifecycle, granular permission modes, MCP resources/prompts and multiple transports, skill/plugin marketplaces, and local/cloud/SSH/WSL desktop workflows. The table below compares those documented behaviors with what is present in OASIS; it does not infer private implementation details or assume that two similarly named features behave identically.

| Capability | OASIS on the inspected main snapshot | Claude Code's current public documentation | Assessment |
| --- | --- | --- | --- |
| Coding loop, file tools and command execution | Source-backed multi-step agent loop, file/Git/command tools, approvals, snapshots, cancellation, context compaction and explicit post-edit diff/check gate. | Interactive CLI, Bash and file tools, task backgrounding, session controls and diff review are documented. | **Broad architectural overlap.** Relative patch quality, instruction-following and success rates remain unmeasured. |
| Subagents and task decomposition | OASIS has custom subagents, bounded worker pools, specialist review, team/task tools, task dependencies and inter-session messaging modules. | Built-in/custom subagents can use independent context, tools, permissions, skills and hooks; agent teams add shared dependency tasks and direct teammate messaging. | **Strong overlap in concepts.** OASIS needs more restart-safe coordination and deeper behavioral testing; exact delegation quality is unknown. |
| Long-running background agents | OASIS persists run events and displays worker/team states in an authenticated monitor. It can mark workers and approvals interrupted after a runtime restart and reopen an eligible saved parent chat. It does not restore the original live worker processes or pending approvals, and does not yet provide a restart-safe pause/resume state machine. | Agent view documents concurrent background sessions, activity summaries, peeking/steering, stop/respawn/delete, resume, and session persistence across machine sleep, updates and supervisor restarts. | **Largest product-level gap.** OASIS has observability and recovery records, but not Claude's documented durable background-session lifecycle. |
| Team messaging and shared task state | OASIS has session/team task state, worker messaging and task checkpoints. Worker registry/leases are still session-scoped; stale lease reconciliation and live-process recovery are incomplete. | Agent teams document directly addressed messages, shared file-backed task lists, dependency blocking, self-claiming and team monitoring. Teams also have documented limits (one team/session, no nested teams and no in-process teammate session resume). | **Partial-to-strong overlap.** Improve persistence and recovery instead of creating another team API. |
| Hooks and lifecycle automation | OASIS has a hook runtime and session, turn, tool and task-related events, including blocking/continuation behavior and bounded execution. | Official hooks docs enumerate session, prompt, tool, subagent, teammate, task, compaction, model-switch, file and configuration events; command, prompt and agent handlers; matchers; async execution; and managed trust controls. | **Broad overlap, not event-for-event parity.** Compare exact event coverage, failure defaults, timeout behavior, plugin/skill scopes and enterprise policy. |
| Permissions and sandbox | OASIS has deny/ask/allow rules, command-chain analysis, approval handling and multiple modes. OS sandboxing is optional, disabled by default, currently targeted at Linux/macOS and is not full filesystem-read isolation; Windows OS isolation is not implemented. | Claude documents default, accept-edits, plan, auto, dontAsk and bypass modes, ordered rules, managed policies and OS sandboxing for supported environments. Native Windows sandboxing is also limited; its docs call out WSL2/Linux/macOS paths. | **Meaningful gap in default enforcement and managed policy.** OASIS should not claim equivalent isolation. |
| MCP integrations | OASIS has MCP client/server integration, OAuth discovery and token storage, transport lifecycle handling, tool schema support and client-side protocol features. | Claude documents stdio, HTTP/Streamable HTTP, deprecated SSE and remote WebSocket transports; scoped server configuration, OAuth/static/dynamic headers, tool approval, resources and prompt invocation. | **MCP support is present, but full transport, scope, auth-helper, resource/prompt and policy parity needs feature-by-feature verification.** |
| Skills and plugins | OASIS supports skill loading and plugin/marketplace adapters, including some Claude-format interoperability. Compatibility is deliberately feature-specific. | Claude documents Markdown skills, automatic/invoked loading, tool allow/deny frontmatter, plugins bundling skills, agents, hooks, MCP and mods, plus user/project/local marketplaces and managed allowlists. | **Strong ecosystem overlap, incomplete compatibility claim.** Keep adapters separable and test real manifests/components rather than claiming drop-in parity. |
| Desktop and remote environments | OASIS offers CLI, local authenticated browser workspace, VS Code-family integration and Electron packaging. Browser/CLI data coordination is incomplete; cloud sessions, SSH/WSL remote execution and native Android APK are not shipped. | Claude Desktop docs describe parallel/split sessions, git worktrees, integrated terminal, diff feedback, connectors, local/SSH/cloud/WSL environments and remote background work; computer use is separately gated. | **Distribution/workspace gap.** OASIS is local-first today, not a cloud/remote multi-environment replacement. |
| Coding performance | The 33-task fixture suite is a regression/smoke harness and is utility-heavy; no authenticated same-model, task-paired Claude Code result is published. | Official feature docs do not provide a directly comparable OASIS-vs-Claude Code benchmark. | **Unknown.** No evidence supports a numeric parity, speed, accuracy or superiority claim. |
| Release maturity | Package version 0.4.0 and release notes are prepared; installers remain unsigned, automatic desktop updates and provenance are not configured, and clean-machine update/uninstall evidence remains open. | Claude's official distribution has its own product and trust infrastructure; this repo audit does not compare publisher operations or paid account infrastructure. | **OASIS Beta release work remains, not Stable/production certification.** |

### What this means for the roadmap

1. **Close the durable-agent lifecycle gap first.** OASIS already has worker/task/run abstractions and a monitor. The next engineering slice should be explicit run states, durable worker/task identity, idempotent lease recovery, safe cancellation, and a truthful resume flow. A recovered transcript must never be shown as a resumed live worker.
2. **Prove execution safety on every advertised platform.** Add native Windows process/isolation strategy or keep the limitation prominent; exercise PTY teardown, process-tree kill, path/symlink escape, network denial and secret handling on clean Windows/macOS/Linux environments.
3. **Raise the benchmark quality.** Expand beyond utility regressions to at least 50 representative pinned-repository tasks, run multiple trials, preserve raw results and publish failures. Use the same model when possible; otherwise distinguish model/provider differences from harness differences.
4. **Tighten ecosystem compatibility without copying proprietary code.** Prioritize MCP resources/prompts/transports, hook event coverage and plugin manifests only where they support a real OASIS workflow. Avoid empty command stubs or superficial name matching.
5. **Finish distribution proof.** Keep unsigned status explicit, add signing/provenance and clean-machine update/uninstall tests, and keep Android/Termux native PTY and APK status honest.

### Official Claude Code documentation inspected

- [Custom subagents](https://code.claude.com/docs/en/sub-agents)
- [Agent teams](https://code.claude.com/docs/en/agent-teams)
- [Background sessions and Agent view](https://code.claude.com/docs/en/agent-view)
- [Hooks reference](https://code.claude.com/docs/en/hooks)
- [Permissions and sandboxing](https://code.claude.com/docs/en/permissions)
- [MCP integration](https://code.claude.com/docs/en/mcp)
- [Agent Skills](https://code.claude.com/docs/en/skills)
- [Plugin architecture and marketplaces](https://code.claude.com/docs/en/plugins/overview)
- [Claude Desktop Code workflow](https://code.claude.com/docs/en/desktop)
- [Interactive CLI mode](https://code.claude.com/docs/en/interactive-mode)

## Ranked gaps and product implications

| Priority | Gap | What the evidence says | Recommended treatment |
| --- | --- | --- | --- |
| **1 — Measurement gate** | Representative coding outcomes | The 33 checked-in tasks are dominated by bounded helpers and validation logic; the audit has no authenticated live head-to-head results. This is the clearest unknown about comparative coding quality. | Expand to at least 50 tasks across multiple pinned repositories, then run repeated, task-level comparisons. |
| **2 — Trust boundary** | Execution isolation and recovery evidence | OASIS has application-level approvals and optional Linux/macOS OS sandboxing, but its own audit says filesystem read isolation is incomplete and native Windows has no OS sandbox. Claude Code documents OS-enforced filesystem/network boundaries on macOS/Linux/WSL2; native Windows sandboxing is also unsupported there. | Tighten OASIS's default trust boundary and adversarially test path escapes, network access, cancellation and failed-tool recovery before increasing autonomy. |
| **3 — Highest-value feature gap** | Durable, observable multi-agent work | OASIS now has a CI-verified authenticated Run monitor with redacted lifecycle history, worktree/branch metadata, approval/usage counts, honest interrupted worker states after restart, and a guarded way to reopen the saved parent chat for workspace-mode runs. It still does not restore workers or approvals, pause/resume orchestration, resolve conflicts, or integrate worktrees. Claude Code documents centralized team management and direct teammate communication, although its agent teams are experimental and disabled by default. | Complete restart-safe lifecycle and conflict-aware integration on top of the existing orchestrator instead of adding another agent-spawning API. |
| **4 — Surface integration** | Remote/cloud workflows and broader IDE coverage | Claude Code documents terminal, VS Code, desktop, browser/web and JetBrains surfaces, including web/mobile access for cloud sessions. OASIS has CLI, local browser workspace, desktop packaging and VS Code-family integration, but not the same cloud/mobile/JetBrains reach. | Only pursue remote/mobile control after identity, workspace isolation, reconnect and audit requirements are designed; prioritize JetBrains only if OASIS users need it. |
| **5 — Distribution confidence** | Signing and clean-install lifecycle | OASIS desktop builds exist, but installers are unsigned and build success does not prove first-run, update or uninstall behavior. | Improve signing/provenance and clean-machine install/update/uninstall tests before broad release claims. |

The order separates **unknown performance** from **missing product capability**. Benchmarking is first because feature inventory alone cannot tell us whether the agent reliably solves real work. Once this evidence gate is in progress, the next major product investment should be the durable multi-agent run lifecycle in priority 3—not more commands or superficial compatibility stubs.

Official comparison references: [Claude Code overview](https://code.claude.com/docs/en/overview), [sandboxing](https://code.claude.com/docs/en/sandboxing), [agent teams](https://code.claude.com/docs/en/agent-teams), and [public releases](https://github.com/anthropics/claude-code/releases).

## OASIS-owned gaps to close

### P0 — Prove coding performance

1. Expand beyond the current 33-task set with at least 17 additional repository-level tasks to reach the 50-task minimum, rather than more isolated helper-only tasks. Include real bug fixes and multi-file features, failing-test diagnosis, architecture-aware changes, regression recovery, large-context continuity, cancellation/resume and permission-denial scenarios.
2. Pin OASIS's exact revision, task snapshot, model/provider, prompt/configuration, permission mode, budgets, timeout and environment. Prefer using the same model for a harness comparison, then run a separate recommended-product comparison if desired.
3. Run at least three trials per task; publish every timeout and failure, raw machine-readable reports, task-level results, token/cost methodology and unreported values as unknown (never as zero).
4. Separate automatic acceptance from blinded human diff review for correctness, regressions, maintainability and test quality. A reference patch that passes establishes a useful verifier; it does not alone establish task realism.
5. Refresh the shared benchmark repository snapshot deliberately. The existing benchmark audit notes that its snapshot is behind current main, so results on that snapshot must not be described as results on current-main code.

**Why this is the leading blocker:** source inspection shows the main agent loop and a broad set of tools exist. What the current repository does not yet show is robust, representative performance on realistic coding work. OASIS's own release criteria should prioritize user outcomes, trust, reliability, usability and its stated product goals; external comparisons remain diagnostic evidence.

### P1 — Close the isolation and recovery evidence gap

- Make the execution trust model explicit and easy to inspect. Document which controls are application-level approvals, which are OS enforcement, which are optional, and what they do not contain.
- Either add supported Windows sandbox/container isolation or state the platform limitation prominently and test the non-sandboxed policy accordingly.
- Add matched safety tests for command injection, symlink/path escape, private-network URL access, secrets in child-process environments, process-tree cancellation, interrupted tool calls and failed worker cleanup.
- Test safe recovery and verification on multi-file changes: new edits must invalidate old diff/check evidence, and a failed or skipped command must never be reported as a passing check.

### P2 — Close selected product and release gaps based on evidence

- Decide which Claude Code-specific published tool contracts are important to OASIS users (for example Projects, Artifacts, remote triggers or notification APIs) and implement only the workflows with a clear product use case.
- Address the documented lack of CLI/browser workspace synchronization if a unified local-first workflow is a product goal.
- Complete cross-platform process cleanup verification and strengthen release provenance/signing. Keep plugin compatibility claims scoped to the formats and behaviors actually tested.

## Verification boundary for the inspected source revision

The source snapshot assessed for this update is [508a0a68d4760f07c22a4037eeb26a6d83c7216f](https://github.com/FAHTHIZ/oasis/commit/508a0a68d4760f07c22a4037eeb26a6d83c7216f); later `main` commits corrected test assertions and refreshed this comparison. On 508, installer checks passed on Windows, macOS and Linux, while the clean-environment suite exposed two stale test matchers; these have been corrected on current `main`. The final current-main Quality Checks, public-site validation, installer checks and three-platform desktop build must all pass on the same SHA before a release is verified. Package version 0.4.0 and curated notes exist, but no GitHub Release is claimed by this audit until the publishing workflow confirms it. Do not treat pending or cancelled workflows as passes.

No comparison in this document proves exhaustive security, broad real-world coding ability, or Claude Code parity. The evidence needed for that is a green same-commit release matrix plus representative, reproducible head-to-head task outcomes with task-level failures and human-reviewed diffs.

## Source register

### OASIS

- [Inspected OASIS source snapshot](https://github.com/FAHTHIZ/oasis/commit/508a0a68d4760f07c22a4037eeb26a6d83c7216f)
- [Agent runtime](../src/agent.mjs)
- [Tool definitions and execution](../src/tools.mjs)
- [Permissions](../src/permissions.mjs) · [Sandbox](../src/sandbox.mjs) · [Runtime regression tests](../test/runtime.test.mjs)
- [Task metadata](../evals/tasks/metadata.json) · [Benchmark protocol](BENCHMARKS.md) · [Benchmark audit](BENCHMARK_AUDIT.md)
- [Quality workflow](../.github/workflows/quality.yml) · [Successful base-revision run](https://github.com/FAHTHIZ/oasis/actions/runs/40840259970)

### Claude Code — official public artifacts

- [Official repository](https://github.com/anthropics/claude-code)
- [Stable release v2.1.314 (October 30, 2026)](https://github.com/anthropics/claude-code/releases/tag/v2.1.314)
- [Published package, 2.1.314](https://unpkg.com/@anthropic-ai/claude-code@2.1.314/)
- [Published package manifest](https://unpkg.com/@anthropic-ai/claude-code@2.1.314/package.json)
- [Published SDK tool schemas](https://unpkg.com/@anthropic-ai/claude-code@2.1.314/sdk-tools.d.ts)
- [Official Claude Code overview](https://code.claude.com/docs/en/overview) · [Sandboxing](https://code.claude.com/docs/en/sandboxing) · [Agent teams](https://code.claude.com/docs/en/agent-teams) · [Current public releases](https://github.com/anthropics/claude-code/releases)

---

**Bottom line:** OASIS is an independent coding-agent project, and this audit should help it become better at its own goals. The external comparison is an engineering instrument—not a product identity or a feature-parity mandate. Immediate work is to strengthen process lifecycle and configuration validation, maintain evidence-backed platform boundaries, and prove real-world task quality with representative, reproducible evaluation.
