# OASIS user guide

OASIS is an open-source, general-purpose agent you run on a computer or server you control and use from the terminal or any modern browser. It works on software, research, data, documents and automation with whichever model you connect. The runtime owns the project, the shell and your model keys; the browser is only the screen. This guide walks through installing it, signing in, connecting a model, running a task and reviewing the result. For examples beyond code, see [Workflows](WORKFLOWS.md).

<p align="center"><img src="../assets/screenshots/web-task-dark.png" alt="OASIS web app after a finished task: the request, a steering note sent while it worked, folded steps for the edit and the test run, a summary table, and the Changes panel with the two changed files" width="860"></p>

## 1. Choose an interface

OASIS has two interfaces that share one runtime, one session store and one set of settings.

| If you want to… | Use | Start it with |
|---|---|---|
| Work in a browser, on this computer or from anywhere | **Web app** | `oasis web --open` |
| Work directly in a terminal | **Terminal session** | `oasis` |

Integrations (editor extension, Agent Client Protocol, Node.js SDK, GitHub Action, messaging gateways) connect OASIS to other tools; see [Interfaces and deployment](INTERFACES.md). A phone, tablet or laptop opens the same web app in its browser. The optional [desktop app](DESKTOP.md) shows it in its own window on Windows, macOS and Linux; there is no separate mobile app.

## 2. Install OASIS

Requirements: Node.js 22.19 or newer and Git.

```sh
git clone https://github.com/FAHTHIZ/oasis.git
cd oasis
npm install
npm install --global .
oasis doctor
```

`oasis --help` lists every command. Release tarballs with `SHA256SUMS` are on [GitHub Releases](https://github.com/FAHTHIZ/oasis/releases/latest); see [Downloads and releases](RELEASES.md).

## 3. Connect a model provider

OASIS is a runtime, not an inference service. Bring a key or a local model server you are allowed to use. Paste it into the web app's connect box (or run `oasis connect` in a terminal): OASIS recognises the provider from the key or address, lists its models, picks a strong default and saves it on the computer running OASIS. Keys are stored there, never sent back to the browser, and never written into the project.

| Provider | Where to get a key | Notes |
|---|---|---|
| OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) | One key for hundreds of models. Free models are limited to 20 requests a minute and 50 a day (1,000 a day after buying $10 of credits), per [OpenRouter's limits](https://openrouter.ai/docs/api_reference/limits). |
| NVIDIA NIM | [build.nvidia.com](https://build.nvidia.com/) | Keys start with `nvapi-`. OpenAI-compatible endpoint `https://integrate.api.nvidia.com/v1`, with a free prototyping tier. |
| OmniRoute | [Self-hosted gateway](https://github.com/cheaper-inference/omniroute) | Runs on `http://localhost:20128/v1` and routes one endpoint to many providers. Paste the address. |
| Anthropic, OpenAI, Gemini, Groq, DeepSeek, xAI, Mistral, Hugging Face | The provider's console | Paste the key; the provider is detected from its prefix. |
| Ollama, LM Studio, llama.cpp | Your own machine | Started servers on their default ports are found automatically. |

Before entering a credential:

- Check that prompts and project context may be sent to that provider.
- Never commit keys, paste them into issues, or show them in screenshots.
- Provider setup over the network is accepted only over HTTPS, so keys are encrypted in transit.

See the [configuration reference](CONFIGURATION.md) for fallback models, task-aware routing and environment variables.

## 4. Terminal session

```sh
cd /path/to/your/project
oasis
```

`oasis` starts the interactive session. `oasis -p "…"` and `oasis exec` run one task for scripts and CI. `oasis models` lists the models your provider serves, and `oasis update` updates a script-installed copy to the latest stable release (a git clone already newer than that release is left alone; use `git pull` to follow main).

### Keep going until a goal holds

`/goal npm test passes` keeps OASIS working, turn after turn, until a strict check of the latest turns says the condition is met and verified (up to 20 turns). The check trusts what ran, not what the agent says: for a condition about a check passing (`npm test passes`, `the build succeeds`), the goal is not met while OASIS has not seen that command run, its latest run failed or hid its exit code behind a pipe, or files changed after it passed, or it ran no tests (every test skipped, or a filter matched nothing), or the agent weakened the tests (skipped, focused or deleted cases, by edit or by a shell command, or rewrote expected values in assertions while changing no code outside the tests, unless you asked for the tests to change), and no model is asked. When the whole condition is one check passing and OASIS saw it pass after the last edit, it is met from that record, again with no model request (on a local model, a judge request re-reads the whole transcript and can take minutes on a CPU). Other conditions go to a judge that also gets the list of commands, checks and edits OASIS recorded from tool results. The judge only reads about the work. With `"goalVerifier": "agent"` in settings (or `OASIS_GOAL_VERIFIER=agent`, or `--goal-verify` with `-p --goal`), a goal the judge calls met is confirmed by the built-in `verify` agent, which runs the result against the condition and fails what it cannot demonstrate. It costs a whole agent run per confirmation, so it is off by default and only runs when the cheap check already says met. `/goal` shows the status and the last check, `/goal pause` and `/goal resume` stop and continue it, `/goal edit CONDITION` changes it and `/goal clear` drops it. Ctrl+C pauses the goal instead of discarding it, and a paused goal is saved with the session.

`oasis -p --review "TASK"` adds an independent review after the work: when the run changed files, the built-in `verify` agent gets the request as acceptance criteria, exercises the result and reports PASS or FAIL per criterion. A failed review goes back to the agent with the findings, and the fix is reviewed again; `--review N` allows up to 3 fix rounds (default 1). A review that still fails ends the run with `error_review_failed` and exit 1, and the result JSON has a `review` field with the verdict. Set `"review": 1` in settings or `OASIS_REVIEW=1` to make it the default for `-p` runs. A separate critic after the work measured the best accuracy for its cost among verification designs in [Rethinking Verification in Agent Harnesses](https://arxiv.org/abs/2610.34577) (+5.9 to +9.5 points on Terminal-Bench at 1.13-1.25x cost).

In scripts and CI use `oasis -p --permission-mode auto --goal "npm test passes"` (add `--goal-turns N`, default 10). A goal that is never met ends with exit code 1 and `subtype: "error_goal_not_met"` in JSON output, and `--output-format stream-json` emits a `goal_check` event after each turn.

By default a `-p` run whose changes OASIS could not verify still exits 0 and ends its reply with a "Not verified" note. Add `--require-verified` (or set `OASIS_REQUIRE_VERIFIED=1`) to make that exit 1 with `subtype: "error_not_verified"`, so a pipeline does not treat an unchecked change as a pass.

A run that stops before finishing exits 1 with `"is_error": true`, as in Claude Code: `--max-turns` reached, or the repeat guard stopping a model that sends the same tool call again and again (both `error_max_turns`), a spending cap (`error_max_budget_usd`, `error_max_requests`, `error_max_total_tokens`), or a failure during the run (`error_during_execution`).

If the model never answers (it returns empty replies three times, or the provider stops the reply with no text), the run exits 1 with `"is_error": true`, subtype `error_during_execution` and `"empty_reply": true`, and the result explains what happened.

Subagents you or OASIS start show up in `/tasks`: running ones first, finished ones under **Earlier in this session**, even after a restart. `/tasks ID` shows a report, `/tasks send ID MESSAGE` steers or resumes one, and `/tasks stop ID` stops it.

### Watch changes live

`/diff --watch` opens a live diff beside the session: inside tmux it splits the window, otherwise run `oasis diff --watch` in a second terminal. The view redraws within a second of any edit and shows every changed and untracked file with a running +/- count. Keys: `j`/`k` scroll, space/`b` page, `n`/`p` jump between files, `s` toggles a per-file summary, `w` pauses and `q` closes it. `oasis diff --stat` prints the summary once.

### Best-of-N attempts

For a hard bug or a change with several reasonable designs, run the task more than once and keep the attempt that holds up:

```bash
oasis attempts 3 --verify "npm test" --apply "fix the date parsing bug in src/dates.js"
oasis attempts --models gpt-5.1,claude-sonnet-4-5 --verify "pytest -q" "make the importer stream large files"
```

Each attempt is a separate `oasis -p` run in its own Git worktree, branched from `HEAD` (uncommitted changes are not included), and the attempts run in parallel (`--concurrency N` limits that). The main checkout's `node_modules` and any `worktree.symlinkDirectories` are shared so your check can run without a fresh install. When an attempt finishes, OASIS saves its patch, runs your `--verify` command in that attempt's worktree, and checks the patch for weakened tests (deleted tests or assertions, added skips, a test script that can no longer fail, expected values rewritten in a patch that changes only tests). Attempts are ranked: changes that pass the check without weakening tests come first, then smaller diffs, then faster runs.

Only a verified attempt can win. `--apply` applies the winner's patch to your checkout (it needs a clean checkout of tracked files); without `--apply` OASIS prints the `git apply` command. Without `--verify` nothing counts as verified and nothing is applied. Patches for every attempt and a `report.json` stay in `.oasis/attempts/<run>/`, which Git ignores; the worktrees and branches are removed unless you pass `--keep`. `--model`, `--max-turns`, `--permission-mode` (default `acceptEdits` for attempts: they can edit their worktree and run read-only commands, and anything that would need approval is denied; use `auto` to let them run their own checks), `--timeout-seconds` and `--json` work as usual, and the command exits 1 when a check was given and no attempt passed.

### Deploy a static site

`oasis deploy` publishes to GitHub Pages: it runs `npm run build` when `package.json` has one, takes the first of `dist`, `build`, `out`, `_site`, `public` or `site` that contains an `index.html` (or the project root, minus Git-ignored files), commits it to the `gh-pages` branch from a scratch index and pushes it. Your branch, working tree and staging area stay as they are, and secret-looking files such as `.env` and private keys are never published. It then turns Pages on through the GitHub CLI and prints the address. `oasis deploy DIR` picks the folder, `--dry-run` lists what would be published, `--no-build` skips the build and `--branch NAME` publishes elsewhere. Pages on private repositories needs a paid GitHub plan.

### Cloud agents on GitHub Actions

Run a task on a GitHub runner while your computer is off, then pick it up locally. It uses your GitHub CLI sign-in and your own model key:

```sh
oasis cloud setup                  # adds .github/workflows/oasis-cloud.yml; commit and push it
gh secret set OASIS_API_KEY        # once per repository (OASIS_PROTOCOL, OASIS_BASE_URL, OASIS_MODEL as variables)
oasis cloud run "Add tests for the date parser"
oasis cloud run --here "Finish this refactor"   # hand off this branch, uncommitted work included
oasis cloud list                   # state of recent cloud tasks
oasis cloud pull ID                # check out the agent's branch here and keep going
```

Each task works on its own branch, `oasis/cloud-ID`, or on your branch with `--here`. The handoff pushes your uncommitted work as a commit on that branch without changing your working tree or staging area. Add `--pr` to have the agent open a pull request when it finishes; otherwise it only pushes the branch. Task records stay in the `.git` folder, so they are never committed.

### Routines that run on a schedule

`/schedule` jobs live only as long as their session. For work that should happen whether or not a terminal is open, create a routine:

```sh
oasis schedule add "0 9 * * 1-5" "Summarize yesterday's CI failures and open PRs" --name standup --workdir . --tz Asia/Dhaka --deliver telegram:123456
oasis schedule add "every 6h" "df -h /" --script --deliver webhook:https://example.com/hook
oasis schedule add "DTSTART;TZID=Asia/Dhaka:20261127T170000 RRULE:FREQ=MONTHLY;BYDAY=-1FR" "Draft the monthly status report" --name monthly
oasis schedule daemon        # keep this running (or run `oasis schedule tick` from crontab)
```

Schedules can be plain phrases (`weekdays at 9am`, `every monday at 14:00`), 5-field cron, `every 2h`, `in 30m`, an ISO date, or an RFC 5545 rule: one `DTSTART` (with `TZID=`, a trailing `Z`, or neither to use `--tz`) and one `RRULE` with FREQ=DAILY, WEEKLY, MONTHLY or YEARLY plus INTERVAL, COUNT, UNTIL, BYDAY (`1MO`, `-1FR`), BYMONTHDAY, BYMONTH, BYYEARDAY, BYWEEKNO, BYSETPOS (`BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1` is the last weekday of the month), BYHOUR, BYMINUTE and WKST. Rules are expanded by [rrule-temporal](https://github.com/ggaabe/rrule-temporal). A rule with COUNT or UNTIL marks the routine completed after its last run. Local times are kept across daylight-saving changes; a time that is skipped moves forward, and a repeated one runs once.

Each run is a fresh background session (`oasis bg list` shows it) with the routine's folder, model, permission mode and skills. `oasis schedule show NAME` lists recent runs and where their output was saved; `pause`, `resume`, `run`, `cancel`, `edit` and `remove` manage it. `--deliver home` sends results to whichever gateway chat you last marked with `/sethome` (see [Home channel](GATEWAYS.md#home-channel)). A run that starts its answer with `[SILENT]` is saved but not delivered. A routine with no usable model credentials is marked `blocked_config` once and spends no tokens. Background runs never wait for approval: only tools your permission rules allow will run, so pick `--permission-mode` deliberately.

To run a routine when something happens instead of on a clock, use `webhook` as the schedule: `oasis schedule add webhook "Triage the new issue in the payload" --name triage --workdir .`. `oasis schedule show triage` prints the URL path and the secret. Add `--event pull_request.opened` (repeatable) to run only for those events. Point a GitHub webhook (or anything that signs with HMAC-SHA256) at `https://YOUR-OASIS/hooks/routines/ID` with that secret. Requests must reach `oasis web`, so use `--public-url` with a tunnel or proxy for outside services.

`oasis web` and `oasis gateway` also run routines while they are open (one scheduler per config folder; `OASIS_ROUTINES=off` turns this off), and Settings → Routines in the browser lists and manages them.

To keep a conversation's context, add `--from-session ID` (from `oasis sessions list`). Every run starts from a copy of that conversation and the original stays as it is. Add `--chain` and each run continues from the last one, so the routine remembers what it found before. In a chat, ask for a routine that "continues this conversation".

You can also ask in a session, for example "check CI every weekday at 9 and send the summary to Telegram". The agent uses its `routine_manage` tool and shows you the exact routine before saving it; you approve every create, edit, resume, extra run or removal, even with `--yes`.

### Skills it learns, with your approval

When a task ends on a passing check and exposes a reusable procedure, the agent may propose it as a skill (`skill_propose`). OASIS also looks for one when a long session compacts: if the work being folded away ended on a passing test, one extra model request reads it and may propose up to two skills. Proposals are files under the config folder, not skills: `/learning` lists them, `/learning approve ID` installs one into `.agents/skills/`, and `/learning reject ID` drops it. A learned skill never grants permissions. Turn compaction proposals off with `"compactionReflection": false` or `OASIS_COMPACTION_REFLECTION=0`, and all learning with `"autoLearning": false` or `OASIS_AUTO_LEARNING=0`.

### Built-in browser and recordings

`oasis --chrome` (or `/chrome on`) gives the agent a real Chrome through the DevTools Protocol: it opens pages, reads them, clicks, types, takes screenshots and checks the console and network. While it works, OASIS keeps a small screenshot after each step that changes the page, with a caption. Typed text is never written into captions, only its length. Ask for a recording (the `recording` browser action), or just close the browser or end the session, and the steps are saved as one self-contained HTML player in `.oasis/recordings/`. Open it in any browser to step through or play back what the agent saw. `OASIS_BROWSER_RECORD=0` turns recording off.

## 5. Browser workspace

### Start it

```sh
cd /path/to/your/project
oasis web --open
```

The terminal prints a private link such as `http://127.0.0.1:3917/app/#token=…`. The access key in the link moves out of the address bar into the tab as soon as the page opens. By default OASIS listens only on this computer and makes a new key on every start.

### Use it from another device

Keep OASIS on loopback and put HTTPS in front of it, for example with Tailscale Serve, Cloudflare Tunnel, Caddy or nginx:

```sh
oasis web --public-url https://oasis.example.com --trust-proxy
```

`--public-url` keeps the same access key across restarts. Open the address on the other device and paste the link or key. `oasis web key` shows the key again, and `oasis web key --rotate` replaces it. [Remote access](REMOTE-ACCESS.md) has copy-paste recipes and the full security model.

<p align="center"><img src="../assets/screenshots/web-sign-in-dark.png" alt="The OASIS sign-in screen asking for the link or access key, with a Remember this device checkbox" width="720"></p>

Tick **Remember this device** on a phone or laptop you own to reconnect without the link. Otherwise the key lives only in that browser tab. Ctrl+K → **Sign out of this browser** forgets it. A key that no longer works (for example after `--rotate`) is dropped, and the sign-in screen says so.

### Follow the work

OASIS narrates as it goes. Short updates in plain words alternate with **execution groups**: each group folds the steps between two updates (files read, edits, commands, searches, subagents) into one line with a step count and duration. Select a group to see each step, and select a step to inspect its exact input and output. Subagents appear inside their group with their task, model and status.

<p align="center"><img src="../assets/screenshots/web-approval-dark.png" alt="An approval request for the npm test command while the step behind it shows as waiting" width="720"></p>

In **Ask first** mode, commands and risky actions wait for you in an approval sheet. The step behind it shows **Waiting**, not **Working**. Close the tab, lose Wi-Fi or reload the page, and the web app reattaches to the running task when it comes back: the timeline is replayed from the server and an open approval is asked again. Answered approvals are not asked twice.

The sidebar (on wide screens) lists this project's tasks with a dot for those still running or waiting on you. Ctrl+B (Cmd+B on macOS) hides or shows it.

### Working in the browser workspace

| Action | How |
| --- | --- |
| Run a command or skill | Type `/` in the message box. Suggestions list built-in commands, your custom commands and skills. Arrow keys move, Tab or Enter accepts, Escape closes. |
| Point at a file | Type `@` and part of a file name, then Tab or Enter to insert the path. The file is attached to the message. |
| Attach a screenshot | Use the image button or paste an image. Text-only models get the message without the image; pick a vision model to use images. |
| Add documents to the project | Open the project menu, choose **Files or zip**, and pick files (PDF, text, images; up to 10 MB each). Protected paths such as `.env` and `.git` are refused, and replacing a file asks first. |
| Switch permission mode | Use the mode chip, or press Shift+Tab in the message box: Ask first, Auto edit, Full auto and Plan. |
| Undo a turn | After a turn that changed files, select **Undo** under the reply. It runs `/undo`, which restores the files and rewinds the conversation. |
| Copy or reuse a message | Hover a message for **Copy** (the original Markdown) and, on your own messages, **Edit**. Code blocks have their own Copy button. |
| Watch the context window | The ring beside the Send button shows how full the context window is. It turns amber at 70% and red at 90%. |
| Know when it's done | In a background tab the page title shows a badge when a task finishes or needs approval. Turn on browser notifications and optional sounds under **Settings**. |
| Work on several tasks | Choose **New task** or another task in the sidebar while one runs. The running task keeps going and shows Working or Needs you; open it again to follow it or answer its approval. Tasks from other browsers or from `oasis` in a terminal are listed under **Other devices and terminal**. On wide screens the approval card sits above the message box, so the sidebar stays usable. One task runs per project at a time. |
| Use a terminal | Press Ctrl+` and choose **Start terminal** for your own shell in the workspace beside the chat. The agent cannot see it, and reloading the page reconnects to it. |
| Download a chat | Ctrl+K → **Download this chat** saves one HTML page with every tool step, no scripts, credentials redacted. |
| Open everything else | Ctrl+K (Cmd+K on macOS) opens the command palette. Ctrl+/ lists every shortcut. |
| Preview what you build | Open the side panel's **Preview** tab. It shows `index.html` (or the first HTML page) and reloads after every turn. Type another file, or a dev server port such as `5173`, in its address bar; the arrow button opens the page in its own tab. Recent browser recordings appear as chips above the page. The page runs sandboxed in its own origin behind a separate preview key, so it cannot read the app, your access key or protected files such as `.env`. |
| Compare design variants | Type `/design pricing page` (any surface). OASIS writes three self-contained variants to `design/<name>/a.html`, `b.html`, `c.html` without touching app code. In the web app, the **Artboards: name** chip in Preview shows them side by side (or type `design:name` in the address bar); **Open** shows one full size and **Use this** drafts the message that asks OASIS to build it for real. |
| Talk with OASIS | Select the waveform button beside the microphone for a hands-free conversation. OASIS listens, sends what you said when you stop talking, works on it, reads the reply aloud (without code blocks or links) and listens again. Say "stop talking", press **End** or Escape to finish; **Skip** stops a reply being read. Replies use your speech model when OASIS has one (`OPENAI_API_KEY` or `OASIS_TTS_BASE_URL`), otherwise the browser's own voice. Where the browser has no speech recognition, OASIS records and transcribes with your transcription endpoint. |
| Connect an app | Type `connect github` or `/connect linear` in the message box, or open **Settings → Apps**. See [Connect apps](#connect-apps). |

The interface follows your system's light or dark theme and honours reduced-motion settings: the particle background, jitter and sweep animations switch off.

### Connect apps

Apps (GitHub, Linear, Notion, Sentry, Stripe, Vercel, Supabase, PostHog, GitLab, Dropbox, Todoist and about 40 more) give the agent their tools through remote MCP servers. You never edit a config file:

1. Ask for it: "connect to GitHub", `/connect notion`, or a server URL such as `/connect https://mcp.example.com/mcp`. The agent can also ask by itself when a task needs an app.
2. A **Connect** card appears in the chat with the app's logo, what it gives access to and why it is being asked. Click **Connect**; **Not now** skips it.
3. Approve access in the page that opens. GitHub uses your GitHub CLI (`gh`) sign-in when it has one, or takes a pasted token. Apps like DeepWiki, Exa and Context7 need no sign-in.
4. The card turns green and the app's tools are ready in the same chat.

If a sign-in expires or is revoked, or an app needs more access for one action, the card comes back with the reason and OASIS retries the action once you connect. **Settings → Apps** lists every app (search it, connected ones first) with Connect and Disconnect; `/disconnect NAME` does the same in the terminal. Tokens stay in the OASIS config folder on the computer running OASIS, never in the project or the browser.

In a terminal, `/connect` lists apps (Tab completes names) and `oasis mcp connect NAME` works outside a session.

## 6. Review every task

Pick a bounded first task with a visible outcome, such as explaining a function, fixing a reproducible bug or adding a focused test.

1. State the outcome you want and any constraints.
2. Read commands and permission requests before approving them.
3. Open **Changes** to inspect every file OASIS touched and its diff. **Discard** in a file's diff puts a tracked file back to its last committed version (after a confirmation); new, untracked files are left alone.
4. Check the tests OASIS ran, their exit status and output.
5. Commit only after you understand and accept the diff.

`/export review.html` writes a standalone review page; `/export notes.md` writes Markdown. A model saying "done" is not a test result; see [Benchmark methodology](development/BENCHMARKS.md).

Saved sessions keep an audit trail next to the conversation: every tool call and its result, each approval decision (yours, a hook's or auto mode's), the checks that ran, and automatic model fallbacks. `oasis sessions events ID` prints it (`--type approval` filters, `--json` for scripts). Secrets are redacted before writing, and `oasis sessions clear ID` deletes the trail with the session.

`oasis sessions export ID...|--all --out FILE.jsonl` writes conversations as JSONL for evaluation or fine-tuning datasets (`--format openai`, the default, `sharegpt`, or `hermes`), with secrets redacted. `hermes` is the function-calling layout Nous Research trains Hermes models on, as [Hermes Agent writes it](https://hermes-agent.nousresearch.com/docs/developer-guide/trajectory-format): a generated system turn listing the tools in `<tools>`, a `<think>` block (empty when the model gave no reasoning) and `<tool_call>` JSON in every `gpt` turn, the results of one turn grouped into a `tool` turn of `<tool_response>` blocks, and per-tool `tool_stats` and `tool_error_counts`. Add `--verified` to keep only sessions whose last recorded check (tests, build, lint or type check) passed with no file edits after it; sessions that never ran a check are left out. That is a filter on recorded evidence, not proof the work is correct.

Long runs make poor training examples when they overflow the model's context. `--compress [TOKENS]` (default 15250) cuts each trajectory to that budget the way [Hermes Agent's trajectory compressor](https://github.com/NousResearch/hermes-agent/blob/main/trajectory_compressor.py) does: the first system, user, assistant and tool turns and the last four turns stay verbatim, and just enough turns from the start of the middle are replaced by one user turn starting `[CONTEXT SUMMARY]:`, written by your configured model. A tool call is never split from its result, the system prompt gets a note that earlier tool results may be summarized, and if the summary request fails a fixed notice is used instead. `--summary-tokens N` (default 750) sizes the summary, `--keep-last N` protects more of the end, and `--metrics FILE` writes dataset totals in Hermes' `compression_metrics.json` shape; each compressed record also carries its own `compression_metrics`. `oasis batch PROMPTS.jsonl --compress` applies the same to batch trajectories.

## 7. Security boundaries

- Approval prompts are not a replacement for operating-system isolation.
- Without an active sandbox backend, commands run with the permissions of the OASIS process.
- Linux, macOS and container sandbox backends have platform-specific prerequisites.
- MCP servers, plugins, hooks and imported skills can run third-party code. Review them before enabling.
- Hosted providers may receive prompts, project context and tool output.
- Anyone with the access key controls the workspace. Share it like a password and rotate it if it leaks.

Read [SECURITY.md](../SECURITY.md) before connecting sensitive workspaces.

## Troubleshooting

Run `oasis doctor` first. Common problems with the web app, providers, the sandbox
and sessions, and their fixes, are in [Troubleshooting](TROUBLESHOOTING.md).

## Further reading

- [Terminal guide](TERMINAL.md)
- [Extending OASIS](EXTENDING.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [Remote access](REMOTE-ACCESS.md)
- [Interfaces and deployment](INTERFACES.md)
- [Downloads and releases](RELEASES.md)
- [Configuration](CONFIGURATION.md)
- [Architecture](ARCHITECTURE.md)
- [Security policy](../SECURITY.md)
- [Support](../SUPPORT.md)
