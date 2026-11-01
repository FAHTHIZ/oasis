# OASIS test map

This directory contains automated unit, subsystem, integration, and regression tests. Test files currently remain at the top level and are run by the explicit `test/*.test.mjs` package script.

## Run tests

```bash
npm test
npm run check
```

Use a focused test while iterating:

```bash
node --test test/<name>.test.mjs
```

The full `npm run check` pipeline additionally validates the public site, repository metadata, evaluation quarantine rules, the model-free harness benchmark (`node bench/harness/run.mjs --check` fails on any regression), and evaluation fixtures. GitHub Actions adds Node-version, operating-system, native PTY, browser, installer, and desktop-package workflows.

## Test domains

Representative files are listed to help contributors find existing coverage. This is a navigational grouping, not a claim that the listed tests fully certify an entire subsystem.

| Domain | Representative test files |
|---|---|
| Agent loop and task coordination | `runtime.test.mjs`, `agent-tasks.test.mjs`, `shared-tasks.test.mjs`, `subtask.test.mjs`, `monitors.test.mjs`, `background-sessions.test.mjs` |
| CLI, commands, and terminal UX | `flags.test.mjs`, `commands.test.mjs`, `commands-extra.test.mjs`, `slash-extra.test.mjs`, `terminal-ui.test.mjs`, `keybindings.test.mjs`, `vim-mode.test.mjs` |
| Providers and configuration | `cloud-providers.test.mjs`, `provider-setup-regressions.test.mjs`, `config-bounds.test.mjs`, `settings-keys.test.mjs`, `ollama-discovery.test.mjs`, `model-routing.test.mjs` |
| Workspace and file operations | `file-state.test.mjs`, `edit-match.test.mjs`, `change-guard.test.mjs`, `protected-paths.test.mjs`, `repo-map.test.mjs`, `notebook.test.mjs`, `pdf.test.mjs` |
| Git, worktrees, and recovery | `git-safety.test.mjs`, `git-tools.test.mjs`, `worktrees.test.mjs`, `cloud-worktree-recovery.test.mjs`, `checkpoints.test.mjs`, `compact-undo.test.mjs` |
| Permissions and security | `permissions.test.mjs`, `command-risk.test.mjs`, `network-safety.test.mjs`, `url-adversarial.test.mjs`, `secret-shield.test.mjs`, `sandbox-enforcement.test.mjs`, `process-tree-cancel.test.mjs` |
| MCP, hooks, plugins, and extensions | `mcp-project.test.mjs`, `mcp-oauth.test.mjs`, `hooks-v3.test.mjs`, `native-plugins.test.mjs`, `extensions.test.mjs`, `claude-plugins.test.mjs` |
| Browser workspace and editor bridges | `web.test.mjs`, `web-pty.test.mjs`, `web-file-preview.test.mjs`, `browser-tool.test.mjs`, `browser-navigation-e2e.test.mjs`, `ide.test.mjs`, `vscode-chat.test.mjs` |
| Verification, evaluation, and reporting | `auto-test.test.mjs`, `test-tamper.test.mjs`, `claim-check.test.mjs`, `eval.test.mjs`, `eval-quarantine.test.mjs`, `diagnostics.test.mjs` |
| Installation, packaging, and lifecycle | `installer-scripts.test.mjs`, `desktop-package.test.mjs`, `desktop-secure-secrets.test.mjs`, `update.test.mjs`, `uninstall.test.mjs`, `license-consistency.test.mjs` |

## Important boundaries

- `test/helpers/` contains support programs and fixtures. They are not test files and must not be accidentally discovered as independent tests.
- The explicit `test/*.test.mjs` script is deliberate. A recursive glob or bare test-runner invocation can pick up helper servers and archived fixtures that are not executable tests.
- `evals/` holds frozen evaluation tasks, snapshots, reference patches and verifiers. Do not move them into `test/` or silently refresh their snapshots.
- Browser E2E orchestration lives in `.github/scripts/browser-e2e.mjs`; it is exercised through the Quality Checks workflow rather than by treating every GitHub script as a local unit test.
- Tests provide evidence for covered cases only. A passing suite does not prove platform security, clean-machine installation, model quality, or full workflow reliability.

## Adding coverage

Name each test after the behavior under test, keep fixtures deterministic, clean up processes and temporary data, and assert observable outcomes. Add regression tests before extracting or moving a runtime module. For tests that require real network, model providers, a browser, native modules, or OS features, keep them in an appropriately gated integration workflow and state the environment requirements.
