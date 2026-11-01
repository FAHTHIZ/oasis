# OASIS documentation

This directory contains the canonical product, user, engineering, security, and release documentation behind the root [README](../README.md). Use this page as the navigation hub; the [repository maintenance guide](REPOSITORY_MAINTENANCE.md) defines file ownership and layout rules.

## Start here

| I need to… | Read this |
|---|---|
| Understand what OASIS is and its current Beta scope | [Root README](../README.md) |
| Check what is implemented, what remains limited, and what blocks release | [Project plan and release status](PROJECT_PLAN.md) |
| Install the CLI or understand desktop availability | [Installation guide](INSTALL.md) |
| Try OASIS on Android | [Android / Termux guide](TERMUX.md) |
| Find the right section of the full user manual | [User-guide map](USER_GUIDE_MAP.md) |
| Learn commands, configuration, tools, sessions, and workflows | [Full user guide](USER_GUIDE.md) |

## Product and engineering

| Document | Purpose |
|---|---|
| [Architecture](ARCHITECTURE.md) | System map, shared runtime, provider adapters, execution/policy boundaries, agent coordination, browser/desktop/editor surfaces, data ownership, and integration trust boundaries. |
| [Workflows and skills](WORKFLOWS_AND_SKILLS.md) | Workflow interaction model, reusable skills, and plugin behavior. |
| [Keyboard shortcuts](KEYS.md) | Terminal shortcuts, keybinding behavior, and mobile notes. |
| [Brand guide](BRAND.md) | Official OASIS naming, visual identity, colors, and logo usage. |
| [Repository maintenance](REPOSITORY_MAINTENANCE.md) | Canonical file ownership, intentional copies, cleanup history, and maintenance rules. |
| [Runtime source map](../src/README.md) | Entry points, domain-oriented module catalog, known large modules, and safe extraction rules. |
| [Test suite map](../test/README.md) | Test domains, focused commands, runner conventions, and fixture boundaries. |

## Trust, privacy, and evaluation

| Document | Purpose |
|---|---|
| [Security policy](../SECURITY.md) | Supported versions and private vulnerability reporting guidance. |
| [Security and reliability audit](SECURITY_RELIABILITY_AUDIT.md) | Dated source-review findings, mitigations, remaining risks, and evidence boundaries. |
| [Privacy notes](PRIVACY.md) | What may be sent to providers, where local data is stored, and integration data flows. |
| [Benchmarks](BENCHMARKS.md) | Regression fixtures, fair-comparison rules, future evaluation tracks, and limits on claims. |

## Integrations and release material

| Document | Purpose |
|---|---|
| [GitHub Action guide](github-action.md) | Mention-triggered repository automation, setup, inputs, and safety boundaries. |
| [GitHub Action workflow example](examples/oasis-github.yml) | Copyable example workflow for a repository. |
| [Changelog](../CHANGELOG.md) | User-facing changes, with a distinct Unreleased section and published version history. |
| [OASIS 0.4.0 Beta notes](releases/v0.4.0.md) | Notes for the published `v0.4.0` GitHub release, including assets and release boundaries. |
| [Contributing guide](../CONTRIBUTING.md) | Development setup, test expectations, dependency policy, and contribution workflow. |
| [License](../LICENSE) | Apache License 2.0 terms. |

## Supporting research and proposals

The [research index](research/README.md) groups time-sensitive comparisons, prior-art reviews, and design proposals. These documents are supporting material—not product specifications, release promises, or proof that a proposed feature has shipped. For current behavior, defer to the root README, project plan, architecture, and user guide.

## Documentation rules

- The root README is the concise public product overview.
- [Project plan](PROJECT_PLAN.md) is the canonical source for current maturity, known limits, priorities, and release gates.
- [Architecture](ARCHITECTURE.md) describes system boundaries and how runtime components fit together.
- [User guide](USER_GUIDE.md) remains the complete behavior and command reference; [its map](USER_GUIDE_MAP.md) provides task-oriented navigation.
- [Repository maintenance](REPOSITORY_MAINTENANCE.md) owns repository layout, file ownership, and cleanup rules.
- Release notes describe a specific immutable release. They must never be used as a substitute for current `main` status.
- Research files are non-normative. A proposal in `docs/research/` is not a shipped feature or a release commitment.
