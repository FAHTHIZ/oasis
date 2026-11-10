# Completion checklist

The working list for the full-product completion mandate. Every item is either
done with evidence, in progress, open, or blocked with a reason. Update it in
the same commit as the work it describes. Detailed notes stay in
[MISSION-LOG.md](MISSION-LOG.md); user-facing notes go in the CHANGELOG.

Status: **done** (tested and pushed) · **doing** · **open** · **blocked**

## 1. Investigation

| Item | Status | Evidence / notes |
| --- | --- | --- |
| Clone and inventory the repository | done | 2,865 commits, ~69k lines in `src/`, ~8k in `app/`, 458 test files (2026-11-10) |
| Read history, mission log, scorecard, architecture docs | done | Desktop (Electron) app retired in `3114f599` on 2026-11-09; browser-only since |
| Baseline: lint, audit, full test suite on Node 22 | done | oxlint 0 warnings; `npm audit` 0 vulnerabilities; 2,384 tests, 0 failures |
| Use the CLI as a new user (clean HOME) | done | `--help`, `doctor`, `connect` (Ollama) and a `-p` task with a local model |
| Use the web workspace as a new user | done | Connected a local model, ran tasks in two tabs; found the busy-folder dead end (fixed) |
| Current competitor scan (Claude Code, Codex, OpenCode, OpenHands) | doing | Claude Code 2.1.322, OpenCode 2.2.6, OpenHands 1.38.0 as of 2026-11-10 |

## 2. Fix and consolidate

| Item | Status | Evidence / notes |
| --- | --- | --- |
| Reproducible bugs found while using the product | doing | Busy folder 409 dead end: fixed. Tests touching the real home folder (stale catalog, 155 leaked backups): fixed |
| Dependency refresh (patch/minor) | done | `859163c5`; undici 8 (major) deferred |
| Continue `src/agent.mjs` (5,105 lines) and `src/cli.mjs` (3,213) decomposition | open | Only with characterization tests first |

## 3. Competitive evaluation

| Item | Status | Evidence / notes |
| --- | --- | --- |
| Same-model, multi-trial benchmark vs Claude Code / Codex / OpenCode | blocked | Needs a model key usable from the sandbox; only a local CPU model is available. No results will be claimed without runs. |

## 4. Desktop distribution (after core validation)

| Item | Status | Evidence / notes |
| --- | --- | --- |
| Restore a desktop shell on the shared runtime | doing | Previous Electron sources in history before `3114f599` (`desktop/`) |
| Windows, macOS (arm64, x64), Linux (AppImage, deb) installers in CI | open | |
| Secure credential storage, auto-update, clean uninstall | open | |

## 5. README and documentation (last)

| Item | Status | Evidence / notes |
| --- | --- | --- |
| README revamp with real screenshots only | open | Do after the product and interfaces stabilise |

## Blockers

- **Model access for benchmarks.** Keys pasted in chat are not used from the
  shell; the secure credential form was declined twice. Real-user runs use a
  local Ollama model, which limits task difficulty and speed.
