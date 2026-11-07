# OASIS documentation

This directory contains maintained technical documentation for the current OASIS codebase. The root [README](../README.md) is the entry point for users; these documents provide the next level of detail.

## Guides

| Document | Covers |
|---|---|
| [First-run guide](FIRST-RUN.md) | Choose an interface, configure a provider, connect a project, review permissions and verify the result. |
| [Architecture](ARCHITECTURE.md) | Runtime components, request flow, persistence and trust boundaries. |
| [Engineering scorecard](ENGINEERING-SCORECARD.md) | Evidence-backed readiness areas, open gates, review cadence and measurable exit criteria. |
| [Configuration reference](CONFIGURATION.md) | Model providers and the provider registry, fallback models, output limits and search-tool options. |
| [Interfaces and deployment](INTERFACES.md) | CLI, desktop, connected browser workspace, PWA, editor, ACP, SDK and integrations. |
| [Benchmark methodology](BENCHMARKS.md) | What the model-free benchmarks measure, what they do not measure and how to interpret live evaluations. |
| [Whole-system replacement roadmap](REPLACEMENT-ROADMAP.md) | Ranked full-system audit, open-source comparisons, retained foundations and replacement acceptance gates. |
| [Architecture alternatives](ARCHITECTURE-ALTERNATIVES.md) | Component-by-component alternatives, implementation anchors and staged migration recommendations. |
| [Agent runtime alternatives](AGENT-RUNTIME-ALTERNATIVES.md) | Agent-framework comparisons, OASIS-owned runtime contracts and incremental extraction guidance. |
| [Project-quality benchmark](PROJECT-QUALITY-BENCHMARK.md) | Repository presentation, onboarding, engineering maturity and release-discipline comparison against a 100-project reference set. |

## Project identity

- [Brand guidelines](../BRAND.md) — official name, portal mark, wordmark, colors, visual usage and motion direction.

## Project policies

- [Security policy](../SECURITY.md)
- [Contributing guide](../CONTRIBUTING.md)
- [Code of Conduct](../CODE_OF_CONDUCT.md)
- [Support and troubleshooting](../SUPPORT.md)
- [Changelog](../CHANGELOG.md)

## Documentation policy

Documentation should describe behaviour that exists in the source code and is covered by tests or a clearly stated implementation boundary. Planned work must be labelled as planned; it must not be presented as an available feature. Release-specific download availability belongs on the GitHub Releases page, not in permanent documentation.
