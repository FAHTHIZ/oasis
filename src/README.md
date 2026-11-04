# OASIS runtime source map

This directory contains the shared Node.js runtime used by the CLI, headless/SDK entry points, browser workspace backend, desktop host, editor integration, and GitHub automation. Files are intentionally still at the top level of `src/`; this page is a navigational map, not a claim that the code has already been split into folders.

## Entry points

| Entry | Responsibility |
|---|---|
| `cli.mjs` | Terminal command parsing, interactive session orchestration, setup and operational commands. |
| `headless.mjs` | Non-interactive and automation-oriented runs. |
| `sdk.mjs` | Programmatic package entry point and public SDK exports. |
| `web.mjs` | Authenticated local HTTP server and browser-workspace API. |
| `ide.mjs` | Editor integration bridge. |
| `github-action.mjs` | GitHub Action entry point. |
| `agent.mjs` | Core model/tool execution loop and turn lifecycle. |

## Module domains

The groups below describe primary responsibility. A module may be used across more than one domain; the table does not define dependency direction or imply that modules can be moved independently.

| Domain | Representative modules |
|---|---|
| Agent runtime and context | `agent.mjs`, `context.mjs`, `memory.mjs`, `auto-memory.mjs`, `learning.mjs`, `rule-refresh.mjs`, `standing-corrections.mjs`, `reply-language.mjs`, `style-rules.mjs`, `tool-aliases.mjs`, `untrusted-content.mjs`, `images.mjs`, `output-styles.mjs` |
| Sessions and recovery | `sessions.mjs`, `session-tools.mjs`, `session-messaging.mjs`, `session-notes.mjs`, `checkpoints.mjs`, `backups.mjs`, `followups.mjs`, `read-dedup.mjs`, `purge.mjs`, `input-history.mjs`, `atomic-write.mjs`, `insights.mjs` |
| Tools and workspace operations | `tools.mjs`, `power-tools.mjs`, `shell-risk.mjs`, `power-tool-definitions.mjs`, `file-state.mjs`, `edit-match.mjs`, `inplace-edit-check.mjs`, `change-guard.mjs`, `repo-map.mjs`, `file-watch.mjs`, `scratch.mjs`, `notebook.mjs`, `pdf.mjs`, `artifacts.mjs`, `ast-grep.mjs`, `html-markdown.mjs`, `json-schema.mjs`, `command-hints.mjs`, `command-lookup.mjs`, `command-output-log.mjs`, `pipe-status.mjs`, `sleep-guard.mjs`, `regex-worker.mjs`, `git-visible-files.mjs`, `monitor-definition.mjs`, `web-search.mjs` |
| Git and isolation | `git-tools.mjs`, `git-safety.mjs`, `auto-commit.mjs`, `worktrees.mjs`, `branch-names.mjs`, `protected-paths.mjs`, `scope-lock.mjs`, `git-intent.mjs` |
| Providers and model selection | `config.mjs`, `cloud-providers.mjs`, `cloud-setup.mjs`, `model-aliases.mjs`, `model-routing.mjs`, `pricing.mjs`, `ollama-discovery.mjs`, `local-context.mjs`, `loopback-fetch.mjs`, `tool-call-repair.mjs`, `provider-models.mjs`, `api-key-helper.mjs`, `auth-cli.mjs`, `proxy.mjs`, `settings.mjs` |
| Permissions and host safety | `permissions.mjs`, `permission-modes.mjs`, `approval-language.mjs`, `sandbox.mjs`, `process-tree.mjs`, `network-safety.mjs`, `public-fetch.mjs`, `safe-regex.mjs`, `safe-storage.mjs`, `secure-store.mjs`, `secret-shield.mjs`, `package-vetting.mjs`, `mcp-trust.mjs`, `security-patterns.mjs`, `security-scan.mjs` |
| Agent coordination and automation | `agent-tasks.mjs`, `subagents.mjs`, `shared-tasks.mjs`, `background-sessions.mjs`, `monitors.mjs`, `workflows.mjs`, `workflow-sandbox.mjs`, `auto-mode.mjs`, `auto-test.mjs`, `ai-comments.mjs`, `teammate-panes.mjs`, `cloud-task-store.mjs` |
| Integration ecosystem | `mcp.mjs`, `mcp-project.mjs`, `mcp-remote-add.mjs`, `mcp-serve.mjs`, `mcp-oauth.mjs`, `mcp-client-features.mjs`, `hooks.mjs`, `plugins.mjs`, `native-plugins.mjs`, `claude-plugins.mjs`, `extensions.mjs`, `frontmatter.mjs`, `importers.mjs`, `zip.mjs`, `mcp-extras.mjs`, `mcp-registry.mjs`, `mcp-auth-commands.mjs`, `channels.mjs`, `github-install.mjs` |
| User interfaces | `slash.mjs`, `commands.mjs`, `terminal-ui.mjs`, `line-editor.mjs`, `keybindings.mjs`, `vim-mode.mjs`, `themes.mjs`, `markdown.mjs`, `completion.mjs`, `select-dialog.mjs`, `status-line.mjs`, `activity-indicator.mjs`, `config-pane.mjs`, `clipboard.mjs`, `clipboard-path.mjs`, `attention.mjs`, `voice.mjs` |
| Browser and device surfaces | `web.mjs`, `browser-tool.mjs`, `cdp.mjs`, `pty-sessions.mjs`, `tool-activity.mjs`, `terminal-ui.mjs`, `ide.mjs`, `github-action.mjs` |
| Installation and lifecycle | `installer.mjs`, `update.mjs`, `uninstall.mjs`, `version.mjs` |
| Verification and diagnostics | `diagnostics.mjs`, `doctor.mjs`, `lsp.mjs`, `eval.mjs`, `eval-report.mjs`, `claim-check.mjs`, `test-tamper.mjs`, `auto-test.mjs`, `network-doctor.mjs`, `skill-doctor.mjs`, `debug-log.mjs`, `telemetry.mjs` |

## Current modularity debt

Several source files have become large orchestration modules. Approximate sizes on 2026-11-04:

| File | Approximate size |
|---|---:|
| `agent.mjs` | 349 KB |
| `cli.mjs` | 224 KB |
| `slash.mjs` | 154 KB |
| `tools.mjs` | 133 KB |
| `web.mjs` | 122 KB |

These figures are a navigation signal, not a mandate to split by line count. A safe extraction needs a stable responsibility, a narrow interface, tests for the extracted behavior, and proof that the import graph and runtime behavior are unchanged.

## Rules for future extraction

1. Start from a behavior with clear inputs/outputs and focused tests; extract one boundary at a time.
2. Preserve CLI command names, tool names and argument schemas, SDK exports, settings keys, storage formats, HTTP routes, and extension contracts unless a deliberate compatibility change is documented.
3. Avoid circular imports and import-time side effects. Shared constants and schema definitions should live in dependency-light modules.
4. Do not create generic `utils/` buckets. Use domain names that express ownership.
5. Run the focused test file first, then `npm test`, `npm run check`, package verification, and the relevant platform/browser workflows.
6. Move files only after their importers, package file lists, test paths, scripts, documentation links, and runtime loaders are updated in the same change.
7. Keep the public entry points thin; orchestration belongs in a domain service when that service can be tested independently.

## Related maps

- [Architecture guide](../docs/ARCHITECTURE.md) — runtime topology, trust boundaries, execution and data ownership.
- [Repository maintenance](../docs/REPOSITORY_MAINTENANCE.md) — folder ownership and intentional copies.
- [Test map](../test/README.md) — test suites and test-runner conventions.
