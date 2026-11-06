<p align="center">
  <img src="assets/oasis-icon.svg" alt="OASIS logo" width="112">
</p>

<h1 align="center">OASIS</h1>

<p align="center">
  <strong>An open-source coding-agent runtime and developer workspace.</strong>
  <br>
  Bring your own model. Work from the terminal, browser, desktop, or editor.
</p>

<p align="center">
  <a href="https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml"><img alt="Quality checks" src="https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/FAHTHIZ/oasis/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/FAHTHIZ/oasis?style=flat-square"></a>
  <a href="https://github.com/FAHTHIZ/oasis/blob/main/LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/github/license/FAHTHIZ/oasis?style=flat-square"></a>
  <img alt="Node.js 22 or newer" src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white&style=flat-square">
</p>

<p align="center">
  <a href="https://github.com/FAHTHIZ/oasis/releases/latest">Download desktop app</a> ·
  <a href="https://fahthiz.github.io/oasis/app/">Open browser app</a> ·
  <a href="MOBILE.md">Mobile setup</a> ·
  <a href="action.yml">GitHub Action</a>
</p>

---

OASIS is an open-source coding-agent runtime and development workspace. It connects a model provider to a project and supplies the runtime around it: workspace tools, command execution, permissions, agent coordination, recovery and verification.

OASIS is the harness and application layer, not a model provider. The model still determines much of the reasoning and code quality; OASIS does not guarantee that every model will solve every task.

## Download and install

### Desktop

Download the current stable release from [GitHub Releases](https://github.com/FAHTHIZ/oasis/releases/latest). Published release builds include:

| Platform | Available packages |
|---|---|
| Windows | x64 and ARM64 `.exe` installers |
| macOS | Apple silicon and Intel `.dmg` installers |
| Linux | x86_64 and ARM64 `.AppImage` and `.deb` packages |

Release assets include `SHA256SUMS`. Verify the checksum before installing a downloaded package. The desktop app checks update assets against the published checksum before installing them.

### Phone and tablet

OASIS has an installable browser app and a connected mobile workspace. Open the [browser app](https://fahthiz.github.io/oasis/app/) and use your browser menu to install it or add it to your home screen. For access to a project running on another computer, follow the [mobile setup guide](MOBILE.md).

There is no native Android APK in the current release. The browser app is a PWA, not a native Android package, and its standalone browser execution model does not provide a host shell.

### CLI

**Requirements:** Node.js 22 or newer and Git.

From a checkout of this repository:

```sh
git clone https://github.com/FAHTHIZ/oasis.git
cd oasis
npm install
npm install --global .
cd /path/to/your/project
oasis connect
oasis
```

`oasis connect` configures a model endpoint. To check the environment or update the CLI:

```sh
oasis doctor
oasis update
```

OASIS does not bundle a model or a hosted inference account. You choose the provider, credentials, model and applicable data-handling terms.

## Interfaces

| Interface | How to open it | What it does |
|---|---|---|
| **CLI and headless runner** | `oasis` or `oasis exec "..."` | Runs the agent in the current project; supports interactive and non-interactive tasks. |
| **Connected browser workspace** | `oasis web --open` | Opens a browser UI while the agent runtime and project access remain on the computer running OASIS. |
| **Universal browser app** | [Open the browser app](https://fahthiz.github.io/oasis/app/) or run `oasis app --open` | Installable PWA for browser storage or a connected GitHub project; it does not provide a host shell. |
| **Desktop application** | [Download a release](https://github.com/FAHTHIZ/oasis/releases/latest) | Electron host for the local runtime and workspace. |
| **Editor integration** | `oasis ide install` | VS Code-family extension with editor context, diagnostics and diff review. |
| **Agent Client Protocol** | `oasis acp` | Connects OASIS to compatible ACP clients. |
| **Node.js SDK** | `src/sdk.mjs` | Embeds OASIS sessions and tools in a Node.js application. |
| **GitHub Action and messaging gateways** | See `action.yml` and `src/` | Runs repository tasks in GitHub Actions and configured chat platforms. |

These interfaces share runtime systems but do not have identical permissions or capabilities. Choose the connected workspace when the agent needs access to a computer's project; use the universal browser app when browser-only access is sufficient.

## Runtime capabilities

- **Model runtime:** provider adapters, streaming, model configuration, retry and fallback handling, and usage tracking.
- **Workspace tools:** file reading, search, editing, patching, command execution, process management and Git operations.
- **Safety controls:** permission modes, approval requests, command-risk analysis, protected paths, secret scanning and optional OS/container sandboxes.
- **Agent coordination:** subagents, specialist reviews, tasks, background sessions, MCP servers, hooks, Agent Skills and plugins.
- **Verification and recovery:** diagnostics, language-server integration, test execution, diff review, session history, checkpoints and worktree-based isolation.
- **Additional tools:** web retrieval, browser-related features, PDF/image handling and voice-related workflows.

Feature availability depends on the interface, operating system, provider and configuration. The optional sandbox is not enabled in every setup and is not a universal security boundary.

## Security and execution boundaries

- Approval prompts are not a replacement for operating-system isolation. Shell commands may run with the permissions of the OASIS process.
- Do not assume a sandbox is active unless OASIS reports that it is available and enabled. Isolation strength varies by platform and backend.
- MCP servers, hooks, plugins and imported extensions can execute third-party code. Review their source and permissions before enabling them.
- Hosted providers and external services may receive prompts, project context or tool output. Review provider data-handling terms before using private repositories.
- Keep important work under version control and maintain backups. Review diffs and command approvals before accepting changes.

See the [security policy](SECURITY.md) for vulnerability reporting.

## Development

```sh
npm install
npm test
npm run check
```

Useful deterministic harness checks:

```sh
npm run bench:harness
npm run bench:tokens
```

`npm test` runs the repository test suite. `npm run check` also runs integrity checks, benchmark-regression checks and evaluation-fixture validation. CI adds platform-specific security regressions, a live Docker sandbox test, native PTY coverage and browser end-to-end checks.

A passing test suite is evidence only for the cases it exercises. It is not proof that the software is defect-free, fully qualified on every platform, security-certified or equivalent to another coding agent.

## Project resources

- [Mobile and tablet setup](MOBILE.md)
- [Contributing guide](CONTRIBUTING.md)
- [Support](SUPPORT.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Issues](https://github.com/FAHTHIZ/oasis/issues)
- [Discussions](https://github.com/FAHTHIZ/oasis/discussions)
- [Latest release](https://github.com/FAHTHIZ/oasis/releases/latest)

## License

OASIS is distributed under the [Apache License 2.0](LICENSE).
