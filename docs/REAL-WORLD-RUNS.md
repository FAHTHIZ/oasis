# Real-world runs

These runs used OASIS the way a person would: type a request, approve steps, read the answer. They used real providers with no scripted model, and were recorded 5–12 November 2026. The model-free harness numbers are in [Benchmarks](BENCHMARKS.md).

## Tasks

| What we asked | Where | Model | Result |
| --- | --- | --- | --- |
| "slugify() in slug.mjs only replaces the first space. Fix it, add a test, run the tests." | Terminal, default mode | gpt-oss-20b (free) | Fixed, test passing after the model corrected its own import twice; 7 m 34 s, 3 approvals, 12 Nov ([video](../assets/demo/oasis-real-model-demo.mp4)) |
| "Build a small to-do web app in index.html: add, complete and delete items, saved in localStorage." | Web app, Ask first | gpt-oss-20b (free) | Working app, existing tests still passing; 231 s, 1 approval, 12 Nov |
| "slugify() only replaces the first space. Fix it, add a test, run the tests." | Web app, Ask first | gpt-oss-20b | Fixed, test added and passing; 409 s, 2 approvals ([screenshot](../assets/screenshots/real-model-approval-dark.png)) |
| "math.mjs add() is wrong. Fix it and add a test, then run it." | `oasis -p` | gpt-oss-20b | Fixed, test passing, exit 0; about 10 minutes, mostly provider wait |
| Read an uploaded PDF | Web app | gpt-oss-20b | Passed in 49 s ([screenshot](../assets/screenshots/real-model-pdf.png)) |
| Install 16 Claude Code plugins and use them | Web app and terminal | gpt-oss-20b | All installed; hooks, skills and MCP servers ran |
| Fix a bug and run the tests after approval | Terminal | gpt-oss-20b | Passed |
| Call an MCP tool in auto mode | Terminal | gpt-oss-20b | Passed |
| Delegate to an `explore` subagent in a worktree | Terminal | gpt-oss-20b | Passed; worktree removed afterwards |
| Continue a terminal session in the browser | Web app | gpt-oss-20b | Passed |

Everything that went wrong in these runs became a fix with a regression test: a streamed reply glued onto the next one, the agent telling the user about its internal checks, a keyless endpoint that kept asking for a key, activity cards that all said "Completed a project step". See the [Changelog](../CHANGELOG.md).

Known rough edges: free endpoints are slow (35–140 s per request), and gpt-oss-20b sometimes writes its reasoning into the reply ("Wait, we still import…"), which OASIS shows as text. The second summary that the verification step used to produce after targeted edits was fixed on 12 November.

## Plugins checked in OASIS

These plugins were installed and used in OASIS on 8 November 2026:

| Plugin | What it adds | Checked in OASIS |
| --- | --- | --- |
| superpowers | Planning, TDD and debugging skills, session-start hook | Skills listed and used; hook ran |
| frontend-design, feature-dev, code-review, pr-review-toolkit, code-simplifier | Agents, skills and commands | Loaded |
| security-guidance | Security hooks | Session-start hook ran (about 10 s) |
| hookify | Your own hooks from plain language | PreToolUse and PostToolUse ran |
| commit-commands | `/commit`, `/commit-push-pr` | Committed in a live run |
| context7, playwright, github, figma | MCP servers | Installed; playwright starts. context7 and figma ask you to sign in (`oasis mcp login context7`); github needs `GITHUB_PERSONAL_ACCESS_TOKEN` |
| typescript-lsp | TypeScript language server | Loaded |
| claude-md-management, ralph-loop | Commands and hooks | Loaded |

On 9 November 2026, BuilderIO/skills, n8n-io/skills, DataDog/pup and NVIDIA/nvidia-kaggle installed through `oasis add` with all 78 of their skills. Some Codex plugins still need their own setup first: nexu-io/codex-slides needs `pnpm install` inside the plugin, and Storybloq needs the `storybloq` program on your PATH.

Plugins are not free. With 16 plugins on, each request used to carry 46 tools and 36.5k characters of tool schemas. OASIS now keeps large MCP servers behind `tool_search` until the model asks for them, which cuts that to 21 tools and 16.5k characters (about 5,000 fewer tokens per request). Plugin prompt text and skills still add up, so turn off the ones you don't use.

## Head-to-head results

There are no head-to-head model results yet. A fair same-model comparison against other agents needs a paid model key. One smoke run through OmniRoute ([raw results](../bench/results/live-2026-11-08-omniroute/README.md)) had OASIS and Claude Code both pass the small task and both fail the medium one. A local 3B model on a 2-core CPU timed out on a small task after 30 minutes. Neither can rank agents, and OASIS does not guarantee that every model will solve every task: on a given task the model matters more than the harness.
