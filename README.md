# OASIS

OASIS is an open-source coding-agent runtime and development workspace. It connects a model you choose to a project, gives the model bounded tools to inspect and change that project, and coordinates execution, permissions, recovery and verification around those tools.

OASIS is the harness and application layer, not a model provider. The model's reasoning and code quality still matter; OASIS does not guarantee that every model will solve every task.

## What is in this repository

OASIS has several interfaces around related runtime capabilities:

- **CLI and headless runner** — interactive terminal sessions, one-shot tasks and automation.
- **Connected browser workspace** — the oasis web command serves the browser UI while the agent runtime and project access remain on the computer running OASIS.
- **Universal browser app** — an installable browser application that can work with a project in browser storage or a connected GitHub repository. When used on its own, it does not provide a host shell.
- **Desktop application** — an Electron host for the connected local workspace.
- **Editor integration** — a VS Code-family extension with chat, selection context, editor diagnostics and native diff review.
- **Agent Client Protocol** — an ACP server for compatible editors.
- **Node.js SDK** — embed OASIS in a Node.js process.
- **GitHub Action and messaging gateways** — run repository tasks in GitHub Actions or through configured chat platforms.

These interfaces are not identical. In particular, the stand-alone browser app, connected browser workspace and local CLI have different execution boundaries.

## Runtime capabilities

The source includes the following systems. Their exact availability depends on the interface, operating system, provider and configuration:

- A multi-step model/tool loop with provider adapters, streaming, model configuration and fallback handling.
- Workspace operations for reading, searching, creating, editing and reviewing files.
- Command execution, process lifecycle management and Git operations, including checkpoints and worktree-based isolation.
- Permission modes, approval requests, command-risk analysis, protected paths and secret scanning.
- Optional operating-system or container sandbox backends. These are configuration-dependent and are not a universal security boundary.
- Sessions, project instructions, memory, context management, compaction, task lists and recovery.
- Subagents, specialist reviews, shared tasks, background sessions and workflow execution.
- MCP servers, hooks, Agent Skills, plugins, extension imports and provider integrations.
- Code intelligence and verification helpers, including diagnostics, language-server integration, tests and diff checks.
- Web retrieval, browser-related tools, image/PDF handling, voice-related features and telemetry.

The implementation is spread across src/, app/, desktop/, ide/, plugins/, skills/ and action.yml. Tests live in test/; frozen agent-evaluation fixtures live in evals/; deterministic runtime benchmarks live in bench/.

## Getting started

**Requirements:** Node.js 22 or newer and Git. Some optional dependencies and capabilities have additional platform requirements.

From a checkout of this repository:

```sh
npm install
npm install -g .
cd /path/to/your/project
oasis connect
oasis
```

The oasis connect command configures a model endpoint. OASIS does not bundle a model or provide a hosted inference account. You are responsible for the provider, its costs and its data-handling terms.

### Other entry points

- **Browser app:** [Open OASIS](https://fahthiz.github.io/oasis/app/). This runs in the browser; it does not give the model access to your computer's shell.
- **Connected browser workspace:** from a project, run oasis web and open the local URL it prints. This runs the agent on that computer.
- **Desktop development build:** run npm install and then npm run desktop:dist. Build output is written to release/.
- **VS Code-family extension:** run oasis ide install after installing the CLI.
- **GitHub Action:** see action.yml for the action interface and inputs.

## Development and checks

```sh
npm test
npm run check
```

npm test runs the repository's explicit Node.js test-file pattern. npm run check runs the broader integrity, test, benchmark-regression and evaluation-fixture checks. Some additional workflows exercise platform-specific behaviour, a real container backend, a native PTY and browser end-to-end paths.

Passing tests are evidence for the cases they cover; they are not proof of defect-free operation, full platform qualification, security certification or model-level coding quality. The benchmark suites measure different things and should not be collapsed into a single score. No claim of parity with another coding agent follows from the existence of these tests.

## Important safety and reliability boundaries

- Review tool approvals and diffs. Approval prompts are not a replacement for operating-system isolation.
- Shell commands and integrations may run with the permissions of the OASIS process. The optional sandbox is not enabled in every setup and does not provide identical isolation on every platform.
- MCP servers, hooks, plugins, imported extensions and workflow code can execute third-party code. Review what you install and the permissions it receives.
- When using a hosted model or external service, relevant prompts, project context and tool output may be sent to that service. Check the provider's terms before using private or sensitive repositories.
- Keep important work under version control and maintain backups. Do not run an unfamiliar agent configuration against a sensitive working directory.

## License

Apache License 2.0. See LICENSE.
