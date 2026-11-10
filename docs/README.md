# OASIS documentation

Use this index to find the right guide without having to understand the repository first. The root [README](../README.md) is the project overview and download entry point.

## Start here

| If you need to… | Read |
|---|---|
| Install OASIS and complete a first task | [User guide](USER-GUIDE.md) |
| Choose between the terminal, the web app and editor integrations | [Interfaces and deployment](INTERFACES.md) |
| Download an installer and verify it | [Downloads and releases](RELEASES.md) |
| Install the desktop app on Windows, macOS or Linux | [Desktop app](DESKTOP.md) |
| Configure providers, models and routing | [Configuration reference](CONFIGURATION.md) |
| Delegate work to subagents and agent teams | [Subagents](SUBAGENTS.md) |
| Understand runtime architecture and security boundaries | [Architecture](ARCHITECTURE.md) |

## User and operator guides

- [User guide](USER-GUIDE.md) — install, connect a provider, use each interface and review results.
- [Downloads and releases](RELEASES.md) — the npm tarball, install scripts, Homebrew and checksums.
- [First-run guide](FIRST-RUN.md) — provider setup, workspace trust, permissions and verification.
- [Desktop app](DESKTOP.md) — installers, first launch on unsigned builds, key storage, updates, data folders and uninstall.
- [Interfaces and deployment](INTERFACES.md) — terminal, web app and remote deployment, editor, ACP, SDK and automation.
- [Configuration reference](CONFIGURATION.md) — provider registry, fallback models, output limits and search options.
- [Comparison with other agent harnesses](COMPARISON.md) — Claude Code, Codex, Gemini CLI, OpenCode, Goose, Pi and Hermes: where OASIS matches, goes further and still lags.
- [Subagents](SUBAGENTS.md) — built-in and custom agents, front matter, structured output, background agents and teams.
- [Remote access](REMOTE-ACCESS.md) — connected browser sessions from another device, set up securely.

## Engineering and architecture

- [Architecture](ARCHITECTURE.md) — runtime components, request flow, persistence and trust boundaries.
- [Engineering scorecard](ENGINEERING-SCORECARD.md) — evidence-backed readiness areas and exit criteria.
- [Whole-system replacement roadmap](REPLACEMENT-ROADMAP.md) — ranked improvements and replacement acceptance gates.
- [Architecture alternatives](ARCHITECTURE-ALTERNATIVES.md) — component alternatives and staged migrations.
- [Agent runtime alternatives](AGENT-RUNTIME-ALTERNATIVES.md) — framework comparisons and OASIS-owned runtime contracts.
- [OASIS Neuron Network](OASIS-NEURON-NETWORK.md) — current lineage projection and planned network architecture.
- [New modules](NEW-MODULES.md) — module boundaries and implementation notes.
- [Provider transport](architecture/provider-transport.md) — protocol-specific provider request and streaming behaviour.

## Quality and evaluation

- [Benchmark methodology](BENCHMARKS.md) — what model-free checks measure and what live evaluations must report.
- [Project-quality benchmark](PROJECT-QUALITY-BENCHMARK.md) — historical repository presentation and engineering comparison against a 100-entry discovery index.

## Project policies

- [Security policy](../SECURITY.md)
- [Contributing guide](../CONTRIBUTING.md)
- [Code of Conduct](../CODE_OF_CONDUCT.md)
- [Support and troubleshooting](../SUPPORT.md)
- [Changelog](../CHANGELOG.md)
- [Brand guidelines](../BRAND.md)

## Documentation policy

Documentation must describe behaviour present in the source code and covered by tests or state an explicit limitation. Planned work must be labelled as planned. Release-specific availability belongs on GitHub Releases; never present a tag or temporary CI artifact as a published installer.
