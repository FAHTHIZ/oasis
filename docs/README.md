# OASIS documentation

This is the canonical navigation hub for OASIS. The root [README](../README.md) introduces the product. This index directs readers to the correct product, operations, engineering, trust, and release references.

## Current product status

OASIS is in **1.0 Release Candidate / Production Qualification**. The 1.0 feature scope is established; the current work is reliability, agent quality, security-boundary validation, accessibility, platform qualification, and operational refinement.

- Development package on `main`: `1.0.0` (Release Candidate 1 metadata)
- Latest published stable release: `v0.4.0`
- RC1 has not been tagged or published. The stable installer continues to resolve `v0.4.0` until stable 1.0.0 is accepted.

The [project and qualification plan](PROJECT_PLAN.md) is the source of truth for release gates and known limits.

## Start here

| I need to… | Read this |
|---|---|
| Understand product scope and maturity | [Root README](../README.md) |
| Check release blockers and supported platforms | [Project and qualification plan](PROJECT_PLAN.md) |
| Install stable downloads or build the RC from source | [Installation guide](INSTALL.md) |
| Use OASIS on Android / Termux | [Termux guide](TERMUX.md) |
| Find a topic in the full manual | [User-guide map](USER_GUIDE_MAP.md) |
| Learn every command, setting, tool, and integration | [Full user guide](USER_GUIDE.md) |

## Product and engineering

| Document | Purpose |
|---|---|
| [Architecture](ARCHITECTURE.md) | Shared runtime, entry points, execution policy, data ownership, integrations, and trust boundaries. |
| [Runtime source map](../src/README.md) | Runtime entry points, module domains, large orchestration modules, and safe extraction rules. |
| [Test suite map](../test/README.md) | Test domains, exact runner commands, fixtures, and discovery conventions. |
| [Repository maintenance](REPOSITORY_MAINTENANCE.md) | Canonical file ownership, intentional copies, main-only maintainer workflow, and modularization discipline. |
| [Workflows and skills](WORKFLOWS_AND_SKILLS.md) | Reusable workflows, command surface, skills, and plugin behavior. |
| [Keyboard shortcuts](KEYS.md) | Terminal and editor shortcuts. |
| [Brand guide](BRAND.md) | OASIS name, portal mark, color tokens, and interface identity. |

## Trust, privacy, and evaluation

| Document | Purpose |
|---|---|
| [Security policy](../SECURITY.md) | Vulnerability reporting and maintained-version policy. |
| [Security and reliability audit](SECURITY_RELIABILITY_AUDIT.md) | Dated source-review findings and evidence boundaries; not a current certification. |
| [Privacy notes](PRIVACY.md) | Provider data flow, local storage, credentials, and integrations. |
| [Benchmarks](BENCHMARKS.md) | Evaluation methodology, frozen fixtures, and limits on claims. |

## Integrations and release history

| Document | Purpose |
|---|---|
| [GitHub Action guide](github-action.md) | Repository automation, configuration, and safety boundaries. |
| [GitHub Action example](examples/oasis-github.yml) | Copyable workflow example. |
| [Changelog](../CHANGELOG.md) | Current 1.0.0 candidate changes and historical release history. |
| [1.0.0 Release Candidate 1 notes](releases/v1.0.0-candidate.md) | Candidate scope, unpublished status, and qualification gates. |
| [Published v0.4.0 notes](releases/v0.4.0.md) | Historical Beta release notes and its downloadable assets. |
| [Contributing guide](../CONTRIBUTING.md) | Development setup, test expectations, and change policy. |
| [License](../LICENSE) | Apache License 2.0. |

## Supporting research

The [research index](research/README.md) groups prior-art reviews, comparisons, and design proposals. Research documents are non-normative: a proposal is not a shipped feature, a support promise, or a release commitment.

## Documentation ownership

- Root README: concise product overview and first-entry navigation.
- Project plan: canonical scope, lifecycle, support matrix, known boundaries, and release gates.
- Architecture: system boundaries and component relationships.
- User guide: complete operational and command reference.
- Security and privacy: trust boundaries and data handling.
- Release notes: immutable, version-specific release content only.
- Research: supporting analysis and proposals, never current product specifications.

When claims conflict, prefer executable code and tests for actual behavior, then use the project plan to understand current support and qualification status. Never use historical v0.4.0 notes as the current product specification.
