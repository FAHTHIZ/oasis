# OASIS supporting research

This folder contains dated research, prior-art reviews, and future design proposals that inform engineering decisions but are not the primary product documentation.

| Document | Purpose | Status |
|---|---|---|
| [Live head-to-head, 2026-11-05](LIVE_COMPARISON_2026-11-05.md) | Real same-model runs of OASIS, Aider, OpenCode and Gemini CLI on the eval tasks, what they exposed in OASIS, and the fixes. | Live smoke test (3 tasks × 1 trial, free tier); not statistically meaningful. |
| [Live head-to-head, 2026-11-05 (second set)](LIVE_COMPARISON_2026-11-05b.md) | OASIS, Aider and OpenCode on gpt-oss-20b and Nemotron 3 Ultra through a model-forcing gateway: results, the token cost of OASIS's loop, and the fixes. | Live smoke test (1 trial per task, free endpoints); not statistically meaningful. |
| [Engineering audit, 2026-11-06](AUDIT_2026-11-06.md) | Measured baseline at `c8cdb51`, architecture map from the implementation, strengths to preserve, and the ranked weaknesses being worked on. | Source review plus local test, harness and fixture runs; no live model runs. |
| [Getting started, model choice and plugins vs eight agents](COMPETITIVE_ANALYSIS_2026-11-05.md) | Onboarding, model selection and fallback, devices and plugins compared with Claude Code, Codex, DeepSeek Harness, Codewhale, Qwen Code, Hermes Agent, OpenCode and Gemini CLI. | Dated documentation comparison; not a benchmark. |
| [Competitive implementation research](COMPETITIVE_ANALYSIS_2026-10-31.md) | A dated source/documentation comparison used to identify capability gaps. | Historical comparison; not a live benchmark or product definition. |
| [Search-engine research](SEARCH_ENGINE_RESEARCH.md) | Prior-art review and architectural rationale for federated search. | Supporting research; check current code/docs for shipped behavior. |
| [Future architecture designs](FUTURE_DESIGNS.md) | Remote-runner, phone-pairing, and Tor/onion design proposals. | Design-only; not shipped product capabilities. |

For authoritative descriptions, use the root [README](../../README.md), [project plan](../PROJECT_PLAN.md), [architecture](../ARCHITECTURE.md), and [user guide](../USER_GUIDE.md). For release evidence use [benchmarks](../BENCHMARKS.md). Research documents are time-sensitive and must be revalidated before being used to make public claims.
