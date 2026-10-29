# OASIS whole-codebase gap register

**Audit date:** October 29, 2026  
**Product direction:** OASIS is an independent open-source coding agent and local-first developer workspace. External products and protocols are reference points when useful; they do not define OASIS's identity or finish line.

## Where OASIS stands today

OASIS is beyond a documentation-only prototype. The repository contains an implemented agent/tool loop, file and command tools, permission evaluation, snapshots and rewind, model/provider adapters, MCP, skills, hooks, plugin loading, memory and context compaction, sessions, subagents, task coordination, worktree support, workflows, diagnostics/LSP, CLI/headless paths, browser workspace, IDE integration, GitHub Action and desktop packaging.

The latest verified implementation snapshot before this documentation refresh is [0002f84a534cd1498b83b5e78fede53922aca7e5](https://github.com/FAHTHIZ/oasis/commit/0002f84a534cd1498b83b5e78fede53922aca7e5):

- [Quality Checks run 40870856114](https://github.com/FAHTHIZ/oasis/actions/runs/40870856114): **685 tests passed, 0 failed**, Node.js 22/24/26; clean-environment tests; 33/33 evaluation fixtures; Linux native PTY; browser E2E; Ubuntu/macOS/Windows security regression jobs.
- [Publishing validation run 40870856141](https://github.com/FAHTHIZ/oasis/actions/runs/40870856141): passed on the same revision.
- The desktop installer workflow [run 40870856180](https://github.com/FAHTHIZ/oasis/actions/runs/40870856180) was still running when reviewed. The current product remains Alpha, installers are unsigned, and a build is not proof of first-run/update/uninstall readiness on clean machines.

These results establish regression and packaging evidence, not production readiness, complete security or representative repository-level coding quality. The current code includes guided first-run setup, desktop OS-backed API-key storage with best-effort rollback, fixed-localhost Ollama discovery, shared approval wording and secret redaction, a responsive chat/terminal workspace, starter prompts, CLI status/help improvements and a Ctrl+K command palette. Phone pairing remains intentionally out of scope because the separately required safety brief was not available for review.

This register is an actionable implementation/status map based on the recursive repository tree and direct inspection of the main runtime, tools, permissions, sandbox, context/memory, task coordination, MCP/hooks, LSP/diagnostics, evaluator, tests and CI. It is not a formal proof that every line or dependency is defect-free.

## Implemented foundations

| Area | Actual code / test surfaces | Assessment |
| --- | --- | --- |
| Agent execution | [`src/agent.mjs`](../src/agent.mjs), [`test/runtime.test.mjs`](../test/runtime.test.mjs) | Multi-step model/tool loop, budgets, cancellation, error feedback, context compaction, and post-edit verification are implemented. |
| Workspace operations | [`src/tools.mjs`](../src/tools.mjs), [`src/power-tools.mjs`](../src/power-tools.mjs) | Bounded reads/search, edits, snapshots, Git tools, command execution and background process APIs exist, with sensitive-path checks and tests. |
| Safety policy | [`src/permissions.mjs`](../src/permissions.mjs), [`src/sandbox.mjs`](../src/sandbox.mjs), [`src/network-safety.mjs`](../src/network-safety.mjs) | Rule precedence, command-risk checks, optional Linux/macOS OS sandboxing, URL/IP validation, and secret filtering exist. |
| Persistence/context | [`src/sessions.mjs`](../src/sessions.mjs), [`src/auto-memory.mjs`](../src/auto-memory.mjs), [`src/context.mjs`](../src/context.mjs) | Saved sessions, memory recall, compaction and budget tracking exist; long-horizon recall still needs representative evaluation. |
| Multi-agent/workflows | [`src/agent-tasks.mjs`](../src/agent-tasks.mjs), [`src/shared-tasks.mjs`](../src/shared-tasks.mjs), [`src/subagents.mjs`](../src/subagents.mjs), [`src/workflows.mjs`](../src/workflows.mjs) | Bounded workers, a session-local task board, dependency-aware dispatch, worktrees and model-directed workflows are implemented; durable team operations remain incomplete. |
| Integrations | [`src/mcp.mjs`](../src/mcp.mjs), [`src/hooks.mjs`](../src/hooks.mjs), [`src/claude-plugins.mjs`](../src/claude-plugins.mjs) | MCP, hook handlers, skills and plugin/marketplace loading exist. Imported prompts and enabled third-party executables remain untrusted/trusted-code boundaries respectively. |
| Developer workspace | [`src/diagnostics.mjs`](../src/diagnostics.mjs), [`src/lsp.mjs`](../src/lsp.mjs), [`ide/vscode`](../ide/vscode), browser/desktop entry points | Diagnostics, language-server tools, editor integration, browser workspace and packaging are implemented, with important platform limits below. |
| Evaluation | [`src/eval.mjs`](../src/eval.mjs), [`evals/tasks/metadata.json`](../evals/tasks/metadata.json), [`docs/BENCHMARKS.md`](BENCHMARKS.md) | A reproducible task runner, reference patches, independent verifiers, fingerprints and report comparison exist. The task set is still too utility-heavy for a general coding-quality score. |

## Remaining gaps, ordered by impact

### P0 — Make correctness claims evidence-based

**Gap:** the task manifest has 33 fixtures: 16 labelled small and 17 medium, with no large tasks. Many tasks focus on parsing, helper functions, validation and bounded security cases. That is valuable regression coverage, but little of it measures sustained repository work.

**Close it when:**
1. The suite contains at least **50 representative tasks** across multiple pinned repositories, including multi-file features, existing-code bugs, failing-test diagnosis/recovery, context continuity, permissions/cancellation, and dependency integration.
2. Every task has a pre-reviewed independent verifier and reference solution; no-op failure and reference success remain required.
3. Each task runs at least three trials with the source revision, task snapshot, model/provider, permissions, time/budget policy, token/cost method and every failure/timeout captured.
4. Automated acceptance and blinded human diff review are reported separately. Benchmark scores must never substitute for product-level correctness or safety checks.

See [the evaluation protocol](BENCHMARKS.md) and [benchmark audit](BENCHMARK_AUDIT.md).

### P0 — Keep execution isolation explicit

**Gap:** permissions are not an operating-system sandbox. The optional sandbox is disabled by default, has Linux/macOS implementations only, and does not provide full filesystem-read isolation. Windows has no OASIS-native OS sandbox.

**Close it when:** Windows isolation is implemented and adversarially tested, or supported-platform claims explicitly limit containment accordingly. Document default settings, workspace writes, readable paths, network egress, host credentials and escape boundaries. Do not label a command safe merely because a permission prompt was satisfied.

### P1 — Prove process lifecycle on every supported platform

**Gap:** timeouts and cancellation must terminate descendants and close inherited handles, not merely signal the leader. Linux/POSIX process groups and Windows `taskkill /T /F` have different semantics.

**Verified on the earlier 9ed2cc9 baseline and regression-tested on 0002f84:** the evaluator, shell/background tools, diagnostics, language servers and read-only Git use the shared process-tree helper. Regression tests cover inherited output pipes and a descendant that ignores SIGTERM after its leader exits. Saved/runtime/turn model budgets reject malformed integer prefixes.

**Remaining work:** extend whole-tree shutdown to Git workflow tools and persistent background-session stops, and impose bounded output plus tree termination on HTTP MCP header helpers. The current quality matrix passes, but Windows process-tree semantics still need dedicated adversarial coverage.

**Close it when:** additional platform-specific tests cover leader-exits-first behavior, cancellation, timeout, inherited-pipe cleanup and LSP/background process shutdown on Windows, macOS and Linux.

### P1 — Reduce filesystem race exposure

**Gap:** canonical path checks, symlink rejection and snapshots reduce risk, but ordinary path-based Node operations do not provide a formal TOCTOU guarantee when an attacker can concurrently replace path components.

**Close it when:** high-risk filesystem operations use the strongest practical descriptor-relative/no-follow primitives supported by each target OS, with adversarial race tests. Until then, advise users to run in a private, trusted workspace and avoid claiming race-proof confinement.

### P1 — Improve durability and visibility of agent work

**Gap:** workers, named teams, task dependencies and bounded worktree dispatch exist, but coordination is session-scoped/model-directed. There is no durable visual run monitor or cross-session team service; branches are not automatically merged and overlap resolution remains limited.

**Close it when:** users can inspect every worker/lease/error, pause and resume safely across restarts, recover stale task claims, review conflicting diffs, and explicitly integrate completed work without bypassing permissions.

### P1 — Validate the browser/local-first product boundaries

**Gap:** browser projects/tasks/notes do not fully sync with CLI workspace state. Dashboard data is local and unencrypted, and the runtime token stored in browser session storage is sensitive. Non-loopback HTTPS relies on operator-provided certificates; mobile trust onboarding and real-device security journeys are unfinished.

**Close it when:** data ownership and sync semantics are deliberate, sensitive fields are protected appropriately, token lifecycle/origin rules are reviewed, and real-device TLS/permission/session-expiry tests pass. Never imply that the local browser workspace is hosted compute or cross-device sync.

### P1 — Finish release confidence

**Gap:** installers are unsigned. A successful build does not prove publisher identity or first-run, update, uninstall and recovery behavior on every advertised platform.

**Close it when:** signing/provenance is configured or unsigned state is unmistakable, checksums and verification instructions are published, and install/update/uninstall smoke tests run on clean Windows/macOS/Linux machines.

### P2 — Close named product gaps only where they serve OASIS users

Known scope gaps include a native Gemini adapter, JetBrains integration, a complete cross-platform PTY lifecycle, a visual/durable multi-agent run monitor, and broader IDE/browser state coordination. Third-party plugin compatibility is feature-by-feature, not universal. Enabled MCP servers, shell hooks and third-party plugin executables execute trusted code and should remain clearly documented as such.

The aim is a coherent OASIS workflow, not simply a longer tool list.

## Immediate acceptance sequence

1. Keep the full Quality Checks and publishing matrix green on new commits; finish desktop installer verification, fix failures rather than weakening assertions, and retain explicit unsigned-installer notes.
2. Keep the platform trust boundary explicit and add Windows process-tree regression coverage, then decide the Windows sandbox plan.
3. Raise the evaluation suite from 33 to at least 50 representative tasks and run repeated trials.
4. Validate complete user journeys across clean installations, browser sessions, model/provider errors, edit → test → review, cancellation/recovery and multi-agent coordination.
5. Revisit release signing/provenance and real-device/browser TLS before calling the project ready for a broad release.

**Definition of progress:** each gap closes only when the implementation, regression test, documented boundary and verification evidence agree. Passing CI is necessary; it is not the entire product definition.
