# Changelog

This file records notable user-facing product changes. It does not imply that an entry has been published as a GitHub Release.

## Unreleased

Reliability and token-efficiency work driven by common coding-agent complaints:

- **Lean tool loading** — rarely used setup/install/terminal/cron tool schemas are deferred (about 2.7k fewer tokens per request) and load automatically on first call or via `tool_search`. Opt out with `leanTools: false` or `OASIS_LEAN_TOOLS=0`.
- **Change guard** — blocks edits that replace real code with placeholders such as `// ... rest of the code unchanged`, warns on large unexplained shrinkage, and detects fix-circling (reverting to an earlier broken state).
- **Commit secret scan** — `git_commit` builds the commit in a throwaway index and scans added lines for real credentials (API tokens, private keys, `PASSWORD=` style assignments, `user:pass@` URLs). Hits are refused with `file:line` and a masked preview; samples like `AKIA…EXAMPLE` and `process.env` references pass. Disable with `OASIS_COMMIT_SECRET_SCAN=0`.
- **Package vetting (slopsquatting guard)** — `install_package`, and `npm/pnpm/yarn/bun add|install`, `pip/uv/poetry` and `cargo add` run through `run_command`/`run_shell`, look each name up on npm, PyPI or crates.io first. Names that do not exist are refused; near-misses of popular packages (including swapped letters), packages first published under 30 days ago, or with under 50 weekly downloads always need a human confirmation, even in auto-approve modes. Offline checks never block. Disable with `OASIS_PACKAGE_VETTING=0`.
- **Git safety snapshots** — before `git checkout .`, `git restore`, `git switch --discard-changes`, `git checkout -f`, `git stash drop/clear`, `git rm`, and shell deletions (`rm`, `unlink`, `find -delete`, `xargs rm`) run, the full working tree including untracked files is saved under `refs/oasis/safety/` without touching your index or stash; the tool result includes the one-line restore command. Disable with `OASIS_GIT_SAFETY=0`.
- **Stop on fatal account errors** — a 429 that really means out of quota/billing/account on hold is no longer retried, and loops, cron prompts and background wake-ups pause after an authentication or billing error until you send the next message.
- **Honest workflow status** — workflows whose agents failed inside `pipeline`/`parallel` now report the failed count, names and errors (`failedAgents`, `warning`, `partial` in `/workflows`) instead of a plain "completed".
- Fixed a FileChanged race: an unlink that happened while a hook ran could be dropped when the hook returned `watchPaths`.
- **Question budget** — at most two `ask_user_question` prompts per turn by default; further questions are answered with "pick a sensible default, state the assumption, keep working" so long runs are not stalled. Configure with `maxQuestionsPerTurn` or `OASIS_MAX_QUESTIONS_PER_TURN` (`off` removes the cap).
- **Claim check** — if the final reply says tests/build pass but the latest check in that turn failed, was piped (masked exit status) or is stale after later edits, the agent is sent back once to rerun and report the real outcome.
- **Test-weakening check** — edits to test files that remove assertions, add `skip`/`xit`/`@pytest.mark.skip` markers or always-true asserts are reported back to the agent, which must fix the code instead or tell the user why the test changed.
- **Compaction deadline** — the summary request is bounded (`OASIS_COMPACT_TIMEOUT_SECONDS`, default 90) and falls back to a local summary; a "Compacting…" notice shows while it runs.
- **Tolerant edit matching** — `edit_file` and `multi_edit` recover from CRLF, trailing whitespace, smart quotes and indentation drift, and give a closest-match hint instead of a bare "not found".
- **Read dedup** — unchanged re-reads return a short pointer instead of the whole file again (`readDedup: false` / `OASIS_READ_DEDUP=0`).
- **Follow-up ledger** — deferred TODOs the agent mentions are captured in `.oasis/followups.json`; manage with `/followups [all|done ID|drop ID|clear]`.
- **Secret shield** — credentials in tool output are masked as `«secret:ID»` placeholders before reaching the model and restored only inside tool arguments (`secretShield: false` / `OASIS_SECRET_SHIELD=0`).
- **Pipe-masked exit warnings** — `cmd | tail` style commands that hide a failing exit status are flagged so "tests pass" claims are not based on a masked result.
- **Background watchdog** — `max_seconds` for background commands, stuck notices after `OASIS_BACKGROUND_STUCK_SECONDS` (default 300) without output, and fixed missing exit notifications for background `run_shell`.
- **`/scope` lock** — restrict edits to given paths (`OASIS_EDIT_SCOPE`) to stop edits beyond the requested scope.
- **Stream watchdog** — long streams are no longer killed by a 120s whole-request timer; idle streams are detected (`OASIS_STREAM_IDLE_SECONDS`, default 120) and can trigger the fallback model. `OASIS_REQUEST_TIMEOUT_SECONDS` overrides the timeout.
- **Tool aliases** — Claude Code style tool names (`Read`, `Edit`, `Bash`, `Glob`, `Grep`, `TodoWrite`, …) and argument shapes map onto OASIS tools; unknown names get did-you-mean suggestions.
- Fixed `oasis skills install` (missing `installSkill`) and the plugin-URL error path in `zip.mjs`.

## 0.4.0 — prepared Beta version (not yet published)

- Expanded the local-first coding workspace across CLI, browser, editor integration and desktop packaging.
- Added or extended multi-provider setup, optional cost-aware model routing, local Ollama/gateway paths and explicit provider verification.
- Improved agent workflows with subagents, task coordination, task checkpoints, isolated worktrees, run monitoring and safer recovery records.
- Expanded MCP, skills, hooks, native plugin packages and workflow automation.
- Strengthened permission boundaries, command-risk handling, URL and DNS validation, secret redaction, bounded storage/output, process-tree cleanup and post-edit verification.
- Improved installer resolution so supported installers select an immutable stable versioned commit rather than a moving branch.
- Added evaluation report comparison and strengthened fixture validation/quarantine controls.

**Release boundaries:** this version remains Beta. Desktop installers are unsigned; automatic desktop updates and publisher provenance are not configured. There is no native Android APK. The 33-fixture evaluator is not a representative repository-scale coding benchmark. See [the v0.4.0 Beta notes](docs/releases/v0.4.0.md) and [project plan](docs/PROJECT_PLAN.md).

## 0.3.0

The repository retains the `v0.3.0` Git tag, but no corresponding GitHub Release object or downloadable assets are currently published. The tag is the latest stable versioned install target at this snapshot; check the [GitHub releases page](https://github.com/FAHTHIZ/oasis/releases) for actual published releases.
