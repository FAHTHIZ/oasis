# OASIS user-guide map

OASIS `1.0.0` is the stable-channel version on `main`; the `v1.0.0` GitHub Release has not been published yet. The [project plan](PROJECT_PLAN.md) owns support status and release gates.

The [full user guide](USER_GUIDE.md) is the comprehensive behavior reference. It remains at its existing path so older links stay valid. This map groups the manual by the task a reader is trying to complete; it does not duplicate the instructions.

## First session

1. [Install the terminal agent](USER_GUIDE.md#install-the-terminal-agent)
2. [Connected browser workspace and runtime](USER_GUIDE.md#connected-browser-workspace-and-runtime)
3. [Terminal help and status](USER_GUIDE.md#terminal-help-and-status)
4. [Settings pane](USER_GUIDE.md#settings-pane)
5. [Use it in plain English](USER_GUIDE.md#use-it-in-plain-english)

## Everyday coding work

- [What is implemented](USER_GUIDE.md#what-is-implemented)
- [Interactive terminal](USER_GUIDE.md#the-interactive-terminal)
- [Vim mode and keybindings](USER_GUIDE.md#vim-mode)
- [Workflow commands](USER_GUIDE.md#workflow-commands)
- [Sessions and cost](USER_GUIDE.md#sessions-and-cost)
- [Slash commands, mentions, and memory](USER_GUIDE.md#slash-commands-mentions-and-memory)
- [Procedural learning and reusable skills](USER_GUIDE.md#procedural-learning)
- [Useful commands](USER_GUIDE.md#useful-commands)

## Permissions, safety, and recovery

- [Safety model](USER_GUIDE.md#safety-model)
- [Permission rules and modes](USER_GUIDE.md#permission-rules-and-modes)
- [Command safety and OS sandbox](USER_GUIDE.md#command-safety-and-os-sandbox)
- [Agent guardrails and token savers](USER_GUIDE.md#agent-guardrails-and-token-savers)
- [Checkpoints and rewind](USER_GUIDE.md#checkpoints-and-rewind)
- [Clearing local data](USER_GUIDE.md#clearing-local-data)
- [Known limitations](USER_GUIDE.md#known-limitations--not-claimed-as-finished)

## Automation and extensibility

- [Native OASIS plugin packages](USER_GUIDE.md#native-oasis-plugin-packages)
- [Plugins, integrations, and installation](USER_GUIDE.md#plugins-integrations-and-installation)
- [Project MCP servers](USER_GUIDE.md#project-mcp-servers-mcpjson)
- [Hooks](USER_GUIDE.md#hooks)
- [Dynamic workflows](USER_GUIDE.md#dynamic-workflows)
- [Watch mode](USER_GUIDE.md#watch-mode-ai-comments-in-your-editor)
- [Subagents and worktree isolation](USER_GUIDE.md#subagents)

## Editor and programmatic integration

- [VS Code, Cursor, and Windsurf](USER_GUIDE.md#vs-code-cursor-and-windsurf)
- [GitHub mention workflow](USER_GUIDE.md#github-mention-oasis)
- [SDK](USER_GUIDE.md#sdk-build-on-oasis-from-node)
- [OpenTelemetry](USER_GUIDE.md#opentelemetry)
- [Headless mode](USER_GUIDE.md#headless-mode-for-scripts-and-ci)

## Verification and development

- [Weakened-test detection and auto-test](USER_GUIDE.md#weakened-test-detection)
- [LSP verification and context estimates](USER_GUIDE.md#lsp-verification-and-context-estimates)
- [Coding-agent evaluations](USER_GUIDE.md#coding-agent-evaluations)
- [Development and verification](USER_GUIDE.md#development-and-verification)
- [Contributing](USER_GUIDE.md#contributing)

## Source-of-truth order

For conflicts, use this order:

1. Executed code and tests for implemented behavior.
2. [Architecture](ARCHITECTURE.md) for system boundaries and component relationships.
3. [Project plan](PROJECT_PLAN.md) for maturity, known limits, priorities, and release gates.
4. This user guide for the steps and configuration of implemented behavior.
5. [Research](research/README.md) for non-normative proposals and comparisons.

A guide page is not proof that every listed platform or integration path has passed release verification. Consult the [project plan](PROJECT_PLAN.md) for current evidence and limitations.
